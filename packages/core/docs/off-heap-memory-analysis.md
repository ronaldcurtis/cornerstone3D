# Off-Heap Cache via WebAssembly.Memory: Analysis & Implementation

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Browser Memory Architecture](#browser-memory-architecture)
3. [Why WebAssembly.Memory](#why-webassemblymemory)
4. [Solution Architecture](#solution-architecture)
5. [The Allocator: OffHeapMemoryPool](#the-allocator-offheapmemorypool)
6. [Integration Points](#integration-points)
7. [Volume Data: Automatic Coverage](#volume-data-automatic-coverage)
8. [Fallback & Graceful Degradation](#fallback--graceful-degradation)
9. [Trade-offs](#trade-offs)
10. [Future Work](#future-work)
11. [References](#references)

---

## Problem Statement

Cornerstone3D's image cache defaults to a 3 GiB maximum, tuned to stay within Chromium's [4 GiB JavaScript heap limit][chromium-4gb]. Medical imaging workflows routinely exceed this.

> **Note:** The 4 GiB limit applies specifically to Chromium-based browsers (Chrome, Edge, Brave, etc.). You can verify this in DevTools:
>
> ```js
> performance.memory.jsHeapSizeLimit; // → 4294967296 (exactly 4 GiB)
> ```

Increasing `_maxCacheSize` beyond ~3 GiB risks crashing the tab because the V8 garbage collector cannot reclaim heap objects fast enough.

```
 Browser Tab Memory
+-------------------------------------------------------+
|                                                       |
|  JS Heap (V8)            4 GiB limit (Chromium)       |
|  +---------------------------------------------------+|
|  | Cornerstone cache    ~3 GiB usable               ||
|  | V8 internals, DOM    ~1 GiB overhead              ||
|  +---------------------------------------------------+|
|                                                       |
|  Off-heap (WASM, GPU, etc.)   Limited by system RAM   |
|                                                       |
+-------------------------------------------------------+
```

The core tension: JavaScript objects in Chromium are confined to a [4 GiB heap][chromium-4gb], but the browser tab can use far more memory through APIs that allocate outside the heap. There is no browser-imposed aggregate cap on total tab memory — the practical limit is available system RAM + swap ([see below](#references)). Each `WebAssembly.Memory` instance is capped at [4 GiB (32-bit addressing)][v8-4gb-wasm], but multiple instances can be created without a fixed upper bound. You can verify this yourself with the [interactive demo](./off-heap-memory-using-wasm-demo.html).

---

## Browser Memory Architecture

A Chromium browser tab's memory is divided into several regions:

```
+------------------------------------------------------------------+
|                     Browser Tab Process                          |
|                                                                  |
|  +------------------+  +------------------+  +----------------+  |
|  |   V8 JS Heap     |  |  WebAssembly     |  |   GPU / GL     |  |
|  |                  |  |  Linear Memory   |  |   Buffers      |  |
|  |  Objects, arrays |  |                  |  |                |  |
|  |  TypedArrays*    |  |  ArrayBuffer     |  |  Textures,     |  |
|  |  closures, etc.  |  |  (off-heap)      |  |  framebuffers  |  |
|  |                  |  |                  |  |                |  |
|  |   4 GiB limit    |  | 4 GiB/instance   |  |  GPU VRAM      |  |
|  +------------------+  +------------------+  +----------------+  |
|                                                                  |
|  +------------------+  +------------------+                      |
|  |  Worker Heaps    |  |  Native / C++    |                      |
|  |  (separate V8)   |  |  (browser code)  |                      |
|  +------------------+  +------------------+                      |
|                                                                  |
|           Total: limited by system RAM, not the browser          |
+------------------------------------------------------------------+

   * TypedArrays on the JS heap count against the 4 GiB limit.
     TypedArrays backed by WebAssembly.Memory do NOT.
```

Key observations:

- **JS Heap (V8):** All JavaScript objects, including `new Uint16Array(n)`, live here. Chromium enforces a hard [4 GiB limit][chromium-4gb] (`performance.memory.jsHeapSizeLimit === 4294967296`).
- **WebAssembly Linear Memory:** Created via `new WebAssembly.Memory(...)`. The backing `ArrayBuffer` lives outside the V8 heap. Each Memory instance is limited to [4 GiB (32-bit addressing)][v8-4gb-wasm], but multiple instances can be created. There is no browser-imposed aggregate limit — the practical cap is available system RAM. (V8 previously reserved ~10 GiB of virtual address space per instance from a 1 TiB pool, limiting the number of instances. [This was removed in V8 9.6.142 / Chrome 96.][stackblitz-v8-wasm])
- **GPU Buffers:** Managed by the WebGL/WebGPU driver. Separate from system RAM.
- **Workers:** Each Web Worker has its own V8 heap, but data must be transferred via `postMessage` or `SharedArrayBuffer`.

The critical insight: **you can create TypedArray views over a `WebAssembly.Memory` buffer**, and those views are fully compatible with all browser APIs (WebGL, Canvas 2D, etc.) while the backing memory does not count against the JS heap.

---

## Why WebAssembly.Memory

Several approaches were considered for off-heap storage:

| Approach               | Off-Heap?        | API Compatible? | Complexity | Drawback                                             |
| ---------------------- | ---------------- | --------------- | ---------- | ---------------------------------------------------- |
| `SharedArrayBuffer`    | Yes              | Yes             | Low        | Requires COOP/COEP headers, not universally deployed |
| `WebAssembly.Memory`   | Yes              | Yes             | Low        | Copy-on-load overhead (~1 ms/image)                  |
| WebGPU Storage Buffers | Yes              | Partial         | High       | Not available in all browsers, read-back is async    |
| IndexedDB/OPFS         | Yes (disk)       | No              | High       | Async, not directly renderable                       |
| Web Worker heaps       | Yes (per-worker) | No              | High       | Requires serialization/transfer                      |

`WebAssembly.Memory` wins because:

1. **No actual WASM code required.** `new WebAssembly.Memory({ initial, maximum })` produces a standard `ArrayBuffer`. No `.wasm` module, no compilation, no toolchain.
2. **TypedArray views are identical.** `new Uint16Array(wasmMemory.buffer, offset, length)` behaves exactly like `new Uint16Array(length)` for all downstream code.
3. **No header requirements.** Unlike `SharedArrayBuffer`, there are no COOP/COEP prerequisites.
4. **Universally supported.** WebAssembly is available in all modern browsers since 2017.
5. **Views never detach.** By creating Memory with `initial === maximum`, the buffer never grows, so views remain valid for the lifetime of the Memory object.

---

## Solution Architecture

The design follows a layered approach with a single integration point:

```
+------------------------------------------------------------------+
|                        Application                               |
|                                                                  |
|    cornerstone.init({                                            |
|      cache: { useOffHeapMemory: true }   <-- opt-in config      |
|    })                                                            |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|  init.ts                                                         |
|  Creates OffHeapMemoryPool, attaches to cache via                |
|  cache.setOffHeapPool(pool)                                      |
+------------------------------------------------------------------+
                              |
          +-------------------+--------------------+
          |                                        |
          v                                        v
+--------------------+                  +------------------------+
|  imageLoader.ts    |                  |  cache.ts              |
|                    |                  |                        |
|  ensureVoxelMgr()  |  -- on load -->  |  putImageLoadObject()  |
|  creates or        |                  |                        |
|  migrates pixel    |                  |  _decacheImage()       |
|  data to WASM      |  <-- on evict -- |  calls pool.free()     |
+--------------------+                  |                        |
          |                             |  purgeCache()          |
          v                             |  calls pool.destroy()  |
+--------------------+                  +------------------------+
| OffHeapMemoryPool  |                             |
|                    |                             |
|  Block 0: 4 GiB   |                             |
|  Block 1: 4 GiB   |  <--- default: 4 blocks (16 GiB); configurable |
|  Block 2: 4 GiB   |       via offHeapMaxBlocks (limited by system RAM) |
|  Block 3: 4 GiB   |                             |
+--------------------+
          |
          v
+--------------------+        +--------------------+
| TypedArray views   | -----> | WebGL textures     |
| (WASM-backed)      |        | (unchanged API)    |
+--------------------+        +--------------------+
```

---

## The Allocator: OffHeapMemoryPool

The pool manages multiple `WebAssembly.Memory` blocks, each up to [4 GiB][v8-4gb-wasm]. Within each block, a free-list allocator tracks available regions.

### Memory Block Layout

```
WebAssembly.Memory Block (e.g. 4 GiB)
+================================================================+
|                                                                |
|  [  Image A: 512 KiB  ][  Image B: 512 KiB  ][  Free ...   ] |
|  offset: 0              offset: 524288         offset: 1048576 |
|                                                                |
+================================================================+
       ^                        ^
       |                        |
  Uint16Array view         Uint16Array view
  (512*512 pixels)         (512*512 pixels)
```

### Free-List Allocator

The allocator uses first-fit with adjacent-block coalescing. This is simple and effective because medical images are highly regular in size (most are 512x512 or 256x256 at a fixed bit depth).

**Allocation sequence:**

```
Initial state: one free block spanning entire Memory
+================================================================+
| [                    FREE: 4 GiB                             ] |
+================================================================+

After allocating Image A (512 KiB) and Image B (512 KiB):
+================================================================+
| [ Image A: 512K ][ Image B: 512K ][      FREE: 4 GiB       ] |
+================================================================+
  Free list: [ { offset: 1048576, size: 4293918720 } ]

After freeing Image A:
+================================================================+
| [  FREE: 512K  ][ Image B: 512K ][      FREE: 4 GiB        ] |
+================================================================+
  Free list: [ { offset: 0, size: 524288 },
               { offset: 1048576, size: 4293918720 } ]

After freeing Image B (triggers coalescing):
+================================================================+
| [                    FREE: 4 GiB                             ] |
+================================================================+
  Free list: [ { offset: 0, size: 4294967296 } ]   <-- coalesced
```

### Alignment

TypedArray views require the byte offset to be a multiple of `BYTES_PER_ELEMENT`. The allocator aligns each allocation:

- `Uint8Array` / `Int8Array`: 1-byte alignment (any offset)
- `Uint16Array` / `Int16Array`: 2-byte alignment
- `Float32Array` / `Uint32Array`: 4-byte alignment
- `Float64Array`: 8-byte alignment

```
Example: Uint8Array(3) followed by Uint16Array(100)

Without alignment:
  offset 0: [U8][U8][U8] offset 3: [U16...] <-- ERROR: offset 3 not divisible by 2

With alignment:
  offset 0: [U8][U8][U8] offset 3: [pad] offset 4: [U16 U16 U16 ...] <-- OK
                          1 byte padding     offset 4 is divisible by 2
```

### Block Size Limit

A single allocation cannot exceed the configured `blockSize`. If an image's pixel data is larger than `blockSize`, it falls back to standard JS-heap storage. This ensures the pool never silently allocates more memory than the user configured. In practice this is rarely an issue — a 4 GiB block comfortably holds any single medical image — but if you work with unusually large data (e.g., whole-slide imaging tiles stitched into a single buffer), ensure `offHeapBlockSize` is large enough.

### Multi-Block Expansion

When a block is full, the pool creates a new `WebAssembly.Memory` block (up to `maxBlocks`). Each block is independent — allocations never span blocks.

```
Pool with 2 blocks:

Block 0 (4 GiB):  [ Image 1 ][ Image 2 ][ ... ][ Image N ][ FREE ]
Block 1 (4 GiB):  [ Image N+1 ][ Image N+2 ][ ... ][ FREE ........ ]

Total addressable: 8 GiB (vs 3 GiB JS heap limit)
```

---

## Integration Points

### Image Loading Path

The single integration point is `ensureVoxelManager()` in `imageLoader.ts`. This function runs after an image is decoded and before it enters the cache. It handles two distinct paths:

**Path A: No voxelManager yet** (simple loaders that only set `getPixelData`)

```
Image Loading Pipeline (Path A):

  Image Loader          Decodes pixels into a
                        JS-heap TypedArray, sets getPixelData
       |
       v
  ensureVoxelManager()  <-- INTEGRATION POINT
       |
       |  if (!image.voxelManager) {
       |    scalarData = image.getPixelData();
       |    if (pool) {
       |      scalarData = pool.allocateAndCopy(scalarData, imageId);
       |    }
       |    image.voxelManager = VoxelManager.createImageVoxelManager(...)
       |  }
       |
       v
  Image Cache           Stores the image with its
                        WASM-backed voxelManager
```

**Path B: VoxelManager already exists** (DICOM image loader creates a voxelManager during decoding)

```
Image Loading Pipeline (Path B):

  DICOM Image Loader    Decodes DICOM pixels, creates
  (createImage.ts)      voxelManager with JS-heap TypedArray
       |
       v
  ensureVoxelManager()  <-- INTEGRATION POINT
       |
       |  if (image.voxelManager && pool) {
       |    scalarData = image.voxelManager.getScalarData();
       |    offHeapData = pool.allocateAndCopy(scalarData, imageId);
       |    image.voxelManager.setScalarData(offHeapData);
       |    // original JS-heap array eligible for GC
       |  }
       |
       v
  Image Cache           Stores the image with its
                        WASM-backed voxelManager
```

In both paths, the result is the same: the image's voxelManager holds a WASM-backed TypedArray view, and downstream code (WebGL rendering, viewport display) works identically.

```
       |
       v
  WebGL Rendering       gl.texSubImage2D/3D accepts
                        any TypedArray source
```

### Cache Eviction Path

When images are evicted (either to make room for new data or during `purgeCache`), the off-heap memory is freed:

```
Cache Eviction:

  Cache pressure or
  explicit removal
       |
       v
  _decacheImage(imageId)
       |
       +---> Cancel loading
       +---> Call decache()
       +---> pool.free(imageId)  <-- frees WASM region
       +---> _imageCache.delete(imageId)

  purgeCache()
       |
       +---> Evict all images
       +---> pool.destroy()   <-- releases all WASM blocks
```

### Cache Size Auto-Increase

The default `_maxCacheSize` in `cache.ts` is 3 GiB — tuned to stay safely within Chromium's 4 GiB JS heap limit. When off-heap memory is enabled, pixel data lives in WASM memory outside the JS heap, so this 3 GiB guard is no longer meaningful.

During `init()`, after the `OffHeapMemoryPool` is created and attached, the cache's max size is automatically raised to the pool's total capacity (`blockSize × maxBlocks`). For the default configuration (4 blocks × 4 GiB), this sets the limit to 16 GiB.

**Why this is necessary:** Without this auto-increase, `CACHE_SIZE_EXCEEDED` would be thrown after ~3 GiB of images even though the off-heap pool has ample capacity — defeating the purpose of the feature.

**Override:** Users can call `cache.setMaxCacheSize()` after `init()` to set a custom limit.

---

## Volume Data: Automatic Coverage

A key finding during implementation: **volumes automatically benefit from off-heap memory** without any volume-specific code changes.

### How Volume Storage Works

Modern Cornerstone3D volumes (via `StreamingImageVolume`) do not allocate a contiguous scalar buffer. Instead, the volume's `VoxelManager` delegates to per-slice image `VoxelManager`s:

```
StreamingImageVolume
+------------------------------------------+
|  volumeId: "ct-volume-1"                |
|  imageIds: ["img:0", "img:1", ... ]     |
|                                          |
|  voxelManager:                           |
|    createImageVolumeVoxelManager()       |
|    +------------------------------------+|
|    |  getAtIndex(globalIndex):          ||
|    |    sliceIndex = globalIndex / WxH  ||
|    |    imageId = imageIds[sliceIndex]  ||
|    |    image = cache.getImage(imageId) ||  <-- looks up cached image
|    |    return image.voxelManager       ||  <-- already WASM-backed
|    |           .getAtIndex(localIndex)  ||
|    +------------------------------------+|
+------------------------------------------+
         |              |              |
         v              v              v
   Image "img:0"  Image "img:1"  Image "img:N"
   [WASM-backed]  [WASM-backed]  [WASM-backed]
```

The loading flow confirms this:

1. `StreamingImageVolume` calls `loadAndCacheImage(imageId)` for each slice
2. Each image is decoded and passes through `ensureVoxelManager()` -- our integration point
3. Pixel data is copied to WASM memory at this stage
4. The volume reads voxels by looking up `cache.getImage(imageId).voxelManager`
5. Those per-image voxel managers already hold WASM-backed views

This means a 500-slice CT volume has its pixel data distributed across 500 WASM-backed TypedArray views, all managed by the pool, with zero volume-specific code.

### The Deprecated Scalar Volume Path

There is an older `createScalarVolumeVoxelManager` that accepts a contiguous `scalarData` buffer. It is marked as deprecated in the source code and its only active call site (`VoxelManager.addInstanceToImage`) wraps a single image's data as a `[width, height, 1]` volume -- which is the same per-image data our off-heap path already handles.

---

## Fallback & Graceful Degradation

The implementation guarantees that off-heap memory failure never breaks functionality:

```
allocateAndCopy(source, imageId):

  try {
    1. Find or create a WASM block with enough space
    2. Allocate region from free list
    3. Create TypedArray view over WASM buffer
    4. Copy source data into view
    5. Return WASM-backed view
  } catch {
    return source   <-- original JS-heap array, unchanged
  }
```

Failure scenarios that trigger fallback:

| Scenario                                      | Behavior                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `WebAssembly` not available (old browser)     | `isSupported()` returns `false`, pool never created               |
| `WebAssembly.Memory` constructor throws (OOM) | `_createBlock` returns `null`, `allocateAndCopy` returns original |
| Single allocation exceeds `blockSize`         | `_createBlock` returns `null`, returns original                   |
| All blocks full, `maxBlocks` reached          | `_findOrCreateBlock` returns `-1`, returns original               |
| Any unexpected error                          | Caught by top-level `try/catch`, returns original                 |

In all cases, the image loads successfully using standard JS-heap storage. The fallback is transparent to all downstream code.

---

## Trade-offs

### Copy Overhead

Each image is copied once from the JS-heap decoded buffer into WASM memory. For a typical 512x512 16-bit image (512 KiB), this takes ~0.5-2 ms using `TypedArray.set()`. The original JS-heap buffer becomes eligible for garbage collection immediately after.

```
Timeline for a single image:

  |-- Decode (5-50ms) --|-- Copy to WASM (~1ms) --|-- GC reclaims original --|

  JS Heap:    [+512K decoded]                     [-512K GC'd]
  WASM Memory:                  [+512K allocated]
  Net JS Heap change: 0
```

For a full 500-slice volume loaded in parallel, the aggregate copy time is negligible compared to network transfer and DICOM decoding.

### Memory Pressure

WASM memory is not automatically released when the browser tab is backgrounded or under system memory pressure. The browser may kill the tab instead of gracefully reducing WASM memory. This is a known limitation of all off-heap strategies.

### Fragmentation

The free-list allocator can fragment over time if images of varying sizes are repeatedly allocated and freed in non-sequential order. In practice, medical images within a study are highly uniform (same matrix size and bit depth), so fragmentation is minimal. The coalescing step merges adjacent free blocks on every `free()` call.

### Opt-In

The feature requires explicit configuration:

```typescript
cornerstone.init({
  cache: {
    useOffHeapMemory: true,
    offHeapBlockSize: 4 * 1024 * 1024 * 1024, // 4 GiB per block
    offHeapMaxBlocks: 4, // 16 GiB default; increase for larger datasets (limited by system RAM)
  },
});
```

The `offHeapMaxBlocks` value can be increased beyond 4 — there is no browser-imposed ceiling. The practical limit is available system memory ([references](#references)).

This ensures zero impact on existing deployments.

---

## Future Work

These enhancements are not included in the current implementation but represent natural next steps:

### Zero-Copy Loading

Pre-allocate WASM regions and pass them as `targetBuffer` to the DICOM image loader's `createImage` function. The decoder would write directly into WASM memory, eliminating the copy step entirely.

```
Current:   Decode -> JS Heap Array -> Copy -> WASM Array -> GC JS Array
Zero-copy: Decode -> WASM Array (direct)
```

### OPFS Cold-Cache Tier

Evicted images could be serialized to the Origin Private File System instead of discarded entirely. Re-loading from OPFS (~10-50 ms) is significantly faster than re-fetching from a PACS server (~100-500 ms).

### Memory Compaction

If fragmentation becomes an issue in long-running sessions, a compaction pass could relocate active allocations to eliminate gaps. This requires temporarily creating new views and updating VoxelManager references.

---

## References

- [Up to 4GB of memory in WebAssembly — V8 Blog][v8-4gb-wasm] — explains the per-instance 4 GiB limit (32-bit addressing)
- [Chasing Memory Bugs through V8 and WebAssembly — StackBlitz][stackblitz-v8-wasm] — documents the old 1 TiB virtual address pool and its removal in V8 9.6.142 (Chrome 96)
- [WebAssembly spec issue #1116: Allow larger memories][wasm-spec-1116]
- [Chromium Memory Usage Backgrounder][chromium-memory-backgrounder]
- [Chromium bug #416284: Limit of 4 GB per tab][chromium-4gb]

[v8-4gb-wasm]: https://v8.dev/blog/4gb-wasm-memory
[stackblitz-v8-wasm]: https://blog.stackblitz.com/posts/debugging-v8-webassembly/
[wasm-spec-1116]: https://github.com/WebAssembly/spec/issues/1116
[chromium-memory-backgrounder]: https://www.chromium.org/developers/memory-usage-backgrounder/
[chromium-4gb]: https://bugs.chromium.org/p/chromium/issues/detail?id=416284
