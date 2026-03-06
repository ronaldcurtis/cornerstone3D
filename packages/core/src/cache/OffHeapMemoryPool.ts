import type { PixelDataTypedArray } from '../types';

const WASM_PAGE_SIZE = 65536; // 64 KiB per WebAssembly page

interface FreeBlock {
  offset: number; // byte offset within the Memory buffer
  size: number; // byte length
}

interface AllocationHandle {
  blockIndex: number;
  offset: number;
  size: number;
}

interface MemoryBlock {
  memory: WebAssembly.Memory;
  freeList: FreeBlock[];
  totalSize: number;
}

/**
 * Manages off-heap memory via WebAssembly.Memory objects.
 *
 * WASM memory lives outside the JS heap, allowing the browser tab to use
 * significantly more memory than the 4 GiB Chromium JS heap limit. Each Memory
 * object is created with `initial === maximum` so that the underlying
 * ArrayBuffer never detaches (no grow() calls).
 *
 * TypedArray views over WASM memory work identically with WebGL, Canvas
 * APIs, and all existing VoxelManager code.
 *
 * ## How to enable
 *
 * Pass `cache.useOffHeapMemory: true` in the Cornerstone init configuration.
 * The pool is created automatically during `init()` and attached to the cache.
 *
 * ```typescript
 * import { init } from '@cornerstonejs/core';
 *
 * // Minimal — uses defaults (4 GiB blocks, 4 blocks = 16 GiB default)
 * init({
 *   cache: {
 *     useOffHeapMemory: true,
 *   },
 * });
 *
 * // Custom block size and count
 * init({
 *   cache: {
 *     useOffHeapMemory: true,
 *     offHeapBlockSize: 2 * 1024 * 1024 * 1024, // 2 GiB per block
 *     offHeapMaxBlocks: 8,                       // 16 GiB (8 x 2 GiB); configurable
 *   },
 * });
 * ```
 *
 * ## How it works
 *
 * 1. After an image is decoded, `ensureVoxelManager()` in `imageLoader.ts`
 *    calls `pool.allocateAndCopy(pixelData, imageId)`.
 * 2. The pixel data is copied into a WASM-backed TypedArray. The original
 *    JS-heap array is released for garbage collection.
 * 3. When an image is evicted from the cache, `cache._decacheImage()` calls
 *    `pool.free(imageId)` to reclaim the WASM region.
 * 4. Volumes benefit automatically — they read voxels from per-image
 *    VoxelManagers that are already backed by WASM memory.
 *
 * If WebAssembly.Memory is unavailable or allocation fails, the pool
 * gracefully falls back to returning the original JS-heap array.
 *
 * ## Manual usage (advanced)
 *
 * You can also create and attach a pool manually without using init config:
 *
 * ```typescript
 * import cache from '@cornerstonejs/core/cache';
 * import { OffHeapMemoryPool } from '@cornerstonejs/core';
 *
 * const pool = new OffHeapMemoryPool(
 *   4 * 1024 * 1024 * 1024, // blockSize: 4 GiB
 *   4                        // maxBlocks: 4
 * );
 * cache.setOffHeapPool(pool);
 *
 * // Later, to disable:
 * cache.getOffHeapPool()?.destroy();
 * cache.setOffHeapPool(null);
 * ```
 *
 * For full technical details, see `packages/core/docs/off-heap-memory-analysis.md`.
 */
class OffHeapMemoryPool {
  private _blocks: MemoryBlock[] = [];
  private _allocations = new Map<string, AllocationHandle>();
  private _blockSize: number;
  private _maxBlocks: number;

  constructor(blockSize: number = 4 * 1024 * 1024 * 1024, maxBlocks = 4) {
    this._blockSize = blockSize;
    this._maxBlocks = maxBlocks;
  }

  static isSupported(): boolean {
    try {
      return typeof WebAssembly !== 'undefined' && !!WebAssembly.Memory;
    } catch {
      return false;
    }
  }

  /**
   * Copies source pixel data into WASM-backed memory and returns a
   * TypedArray view over it. The caller can then drop its reference to
   * the original JS-heap array, allowing GC to reclaim it.
   *
   * On failure (e.g. OOM, unsupported), returns the original source array
   * so the caller transparently falls back to JS-heap storage.
   */
  allocateAndCopy(
    source: PixelDataTypedArray,
    imageId: string
  ): PixelDataTypedArray {
    try {
      // If already allocated for this imageId, free first
      if (this._allocations.has(imageId)) {
        this.free(imageId);
      }

      const byteLength = source.byteLength;
      const alignment = source.BYTES_PER_ELEMENT;
      const blockIndex = this._findOrCreateBlock(byteLength, alignment);

      if (blockIndex === -1) {
        return source;
      }

      const block = this._blocks[blockIndex];
      const offset = this._allocateFromBlock(block, byteLength, alignment);

      if (offset === -1) {
        return source;
      }

      // Create a typed array view over the WASM memory buffer
      const view = this._createTypedView(
        source,
        block.memory.buffer,
        offset,
        source.length
      );

      // Copy data from JS heap into WASM memory
      view.set(source);

      this._allocations.set(imageId, {
        blockIndex,
        offset,
        size: byteLength,
      });

      return view as PixelDataTypedArray;
    } catch {
      // Graceful fallback to JS-heap storage
      return source;
    }
  }

  /**
   * Frees the WASM memory region associated with the given imageId.
   */
  free(imageId: string): void {
    const handle = this._allocations.get(imageId);
    if (!handle) {
      return;
    }

    const block = this._blocks[handle.blockIndex];
    if (block) {
      block.freeList.push({ offset: handle.offset, size: handle.size });
      this._coalesceFreeList(block.freeList);
    }

    this._allocations.delete(imageId);
  }

  /**
   * Releases all WASM Memory blocks.
   */
  destroy(): void {
    this._blocks = [];
    this._allocations.clear();
  }

  /**
   * Returns the total number of bytes currently allocated across all blocks.
   */
  getAllocatedBytes(): number {
    let total = 0;
    for (const [, handle] of this._allocations) {
      total += handle.size;
    }
    return total;
  }

  /**
   * Returns the number of active allocations.
   */
  getAllocationCount(): number {
    return this._allocations.size;
  }

  /**
   * Returns the maximum total capacity of the pool in bytes
   * (blockSize * maxBlocks).
   */
  getMaxCapacity(): number {
    return this._blockSize * this._maxBlocks;
  }

  // ---- Private helpers ----

  /**
   * Finds a block with enough free space, or creates a new one.
   * Returns block index, or -1 if unable.
   */
  private _findOrCreateBlock(byteLength: number, alignment: number): number {
    // First-fit among existing blocks
    for (let i = 0; i < this._blocks.length; i++) {
      if (this._canFit(this._blocks[i], byteLength, alignment)) {
        return i;
      }
    }

    // Need a new block
    if (this._blocks.length >= this._maxBlocks) {
      return -1;
    }

    const block = this._createBlock(byteLength);
    if (!block) {
      return -1;
    }

    this._blocks.push(block);
    return this._blocks.length - 1;
  }

  private _canFit(
    block: MemoryBlock,
    byteLength: number,
    alignment: number
  ): boolean {
    for (const free of block.freeList) {
      const alignedOffset = this._alignUp(free.offset, alignment);
      const padding = alignedOffset - free.offset;
      if (free.size - padding >= byteLength) {
        return true;
      }
    }
    return false;
  }

  /**
   * Allocates from a block's free list using first-fit.
   * Returns byte offset, or -1 if no fit (shouldn't happen after _canFit check).
   */
  private _allocateFromBlock(
    block: MemoryBlock,
    byteLength: number,
    alignment: number
  ): number {
    for (let i = 0; i < block.freeList.length; i++) {
      const free = block.freeList[i];
      const alignedOffset = this._alignUp(free.offset, alignment);
      const padding = alignedOffset - free.offset;
      const needed = padding + byteLength;

      if (free.size >= needed) {
        // If there's leftover padding at the start, keep it as a free block
        if (padding > 0) {
          block.freeList.splice(i, 1, {
            offset: free.offset,
            size: padding,
          });
          i++; // skip past the padding block
        } else {
          block.freeList.splice(i, 1);
        }

        // If there's leftover space after the allocation, add it as free
        const remainder = free.size - needed;
        if (remainder > 0) {
          block.freeList.splice(i, 0, {
            offset: alignedOffset + byteLength,
            size: remainder,
          });
        }

        return alignedOffset;
      }
    }
    return -1;
  }

  private _createBlock(minSize: number): MemoryBlock | null {
    try {
      // Reject allocations that exceed the configured block size
      if (minSize > this._blockSize) {
        return null;
      }
      const pages = Math.ceil(this._blockSize / WASM_PAGE_SIZE);

      const memory = new WebAssembly.Memory({
        initial: pages,
        maximum: pages,
      });

      return {
        memory,
        freeList: [{ offset: 0, size: pages * WASM_PAGE_SIZE }],
        totalSize: pages * WASM_PAGE_SIZE,
      };
    } catch {
      return null;
    }
  }

  private _createTypedView(
    source: PixelDataTypedArray,
    buffer: ArrayBuffer,
    byteOffset: number,
    length: number
  ): PixelDataTypedArray {
    // Match the source's constructor to create the same TypedArray type
    const Ctor = source.constructor as new (
      buffer: ArrayBuffer,
      byteOffset: number,
      length: number
    ) => PixelDataTypedArray;
    return new Ctor(buffer, byteOffset, length);
  }

  /**
   * Aligns `offset` up to the next multiple of `alignment`.
   */
  private _alignUp(offset: number, alignment: number): number {
    return Math.ceil(offset / alignment) * alignment;
  }

  /**
   * Coalesces adjacent free blocks in-place.
   */
  private _coalesceFreeList(freeList: FreeBlock[]): void {
    if (freeList.length < 2) {
      return;
    }

    freeList.sort((a, b) => a.offset - b.offset);

    let i = 0;
    while (i < freeList.length - 1) {
      const current = freeList[i];
      const next = freeList[i + 1];

      if (current.offset + current.size === next.offset) {
        current.size += next.size;
        freeList.splice(i + 1, 1);
      } else {
        i++;
      }
    }
  }
}

export default OffHeapMemoryPool;
export { OffHeapMemoryPool };
