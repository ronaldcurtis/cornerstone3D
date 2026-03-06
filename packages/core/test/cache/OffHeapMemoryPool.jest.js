import { OffHeapMemoryPool } from '../../src/cache/OffHeapMemoryPool';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Use small blocks (64 KiB = 1 WASM page) for fast, lightweight tests
const SMALL_BLOCK = 65536;

describe('OffHeapMemoryPool', () => {
  let pool;

  beforeEach(() => {
    pool = new OffHeapMemoryPool(SMALL_BLOCK, 4);
  });

  afterEach(() => {
    pool.destroy();
  });

  describe('isSupported', () => {
    it('should return true when WebAssembly.Memory is available', () => {
      expect(OffHeapMemoryPool.isSupported()).toBe(true);
    });
  });

  describe('allocateAndCopy', () => {
    it('should copy Uint16Array data to WASM-backed memory', () => {
      const source = new Uint16Array([1, 2, 3, 4, 5]);
      const result = pool.allocateAndCopy(source, 'img:1');

      expect(result).not.toBe(source);
      expect(result.length).toBe(source.length);
      expect(result.BYTES_PER_ELEMENT).toBe(source.BYTES_PER_ELEMENT);
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    });

    it('should copy Float32Array data to WASM-backed memory', () => {
      const source = new Float32Array([1.5, 2.5, 3.5]);
      const result = pool.allocateAndCopy(source, 'img:float');

      expect(result).not.toBe(source);
      expect(result.length).toBe(source.length);
      expect(result instanceof Float32Array).toBe(true);
      expect(Array.from(result)).toEqual([1.5, 2.5, 3.5]);
    });

    it('should copy Uint8Array data to WASM-backed memory', () => {
      const source = new Uint8Array([10, 20, 30, 40]);
      const result = pool.allocateAndCopy(source, 'img:uint8');

      expect(result).not.toBe(source);
      expect(result instanceof Uint8Array).toBe(true);
      expect(Array.from(result)).toEqual([10, 20, 30, 40]);
    });

    it('should copy Int16Array data to WASM-backed memory', () => {
      const source = new Int16Array([-100, 0, 100, 200]);
      const result = pool.allocateAndCopy(source, 'img:int16');

      expect(result).not.toBe(source);
      expect(result instanceof Int16Array).toBe(true);
      expect(Array.from(result)).toEqual([-100, 0, 100, 200]);
    });

    it('should handle multiple allocations in the same block', () => {
      const img1 = new Uint16Array(100);
      const img2 = new Uint16Array(100);
      const img3 = new Uint16Array(100);

      img1.fill(1);
      img2.fill(2);
      img3.fill(3);

      const r1 = pool.allocateAndCopy(img1, 'img:a');
      const r2 = pool.allocateAndCopy(img2, 'img:b');
      const r3 = pool.allocateAndCopy(img3, 'img:c');

      // Each should have correct data and be distinct views
      expect(r1[0]).toBe(1);
      expect(r2[0]).toBe(2);
      expect(r3[0]).toBe(3);
      expect(pool.getAllocationCount()).toBe(3);
    });

    it('should replace allocation if same imageId is used again', () => {
      const source1 = new Uint16Array([1, 2, 3]);
      const source2 = new Uint16Array([4, 5, 6]);

      pool.allocateAndCopy(source1, 'img:dup');
      const result = pool.allocateAndCopy(source2, 'img:dup');

      expect(Array.from(result)).toEqual([4, 5, 6]);
      expect(pool.getAllocationCount()).toBe(1);
    });

    it('should handle a realistic 512x512 Uint16 image', () => {
      // 512x512 Uint16 = 512 KiB, need a bigger block
      const bigPool = new OffHeapMemoryPool(1024 * 1024, 2);
      const source = new Uint16Array(512 * 512);
      source[0] = 42;
      source[512 * 512 - 1] = 99;

      const result = bigPool.allocateAndCopy(source, 'img:ct-slice');

      expect(result.length).toBe(512 * 512);
      expect(result[0]).toBe(42);
      expect(result[512 * 512 - 1]).toBe(99);
      expect(result).not.toBe(source);

      bigPool.destroy();
    });
  });

  describe('free', () => {
    it('should free an allocation and allow reuse', () => {
      const source = new Uint16Array(100);
      pool.allocateAndCopy(source, 'img:free-test');
      expect(pool.getAllocationCount()).toBe(1);

      pool.free('img:free-test');
      expect(pool.getAllocationCount()).toBe(0);

      // Should be able to allocate again in the same space
      const result = pool.allocateAndCopy(source, 'img:reuse');
      expect(result.length).toBe(100);
      expect(pool.getAllocationCount()).toBe(1);
    });

    it('should be a no-op for unknown imageIds', () => {
      pool.free('img:nonexistent');
      expect(pool.getAllocationCount()).toBe(0);
    });
  });

  describe('coalescing', () => {
    it('should coalesce adjacent free blocks', () => {
      const a = new Uint8Array(100);
      const b = new Uint8Array(100);
      const c = new Uint8Array(100);

      pool.allocateAndCopy(a, 'img:a');
      pool.allocateAndCopy(b, 'img:b');
      pool.allocateAndCopy(c, 'img:c');

      // Free b and c (adjacent), then a (adjacent to b+c region)
      pool.free('img:b');
      pool.free('img:c');
      pool.free('img:a');

      // All space should be coalesced; we can allocate the full block again
      const big = new Uint8Array(300);
      const result = pool.allocateAndCopy(big, 'img:big');
      expect(result.length).toBe(300);
    });
  });

  describe('multi-block', () => {
    it('should create additional blocks when the first is full', () => {
      // Each block is 64 KiB (1 WASM page). Fill with allocations.
      const size = 32768; // 32 KiB in Uint8
      const a = new Uint8Array(size);
      const b = new Uint8Array(size);
      const c = new Uint8Array(size);

      // a + b should fill the first block (32K + 32K = 64K)
      pool.allocateAndCopy(a, 'img:1');
      pool.allocateAndCopy(b, 'img:2');
      // c should go into a second block
      pool.allocateAndCopy(c, 'img:3');

      expect(pool.getAllocationCount()).toBe(3);
      expect(pool.getAllocatedBytes()).toBe(size * 3);
    });

    it('should respect maxBlocks limit and fall back gracefully', () => {
      const tinyPool = new OffHeapMemoryPool(SMALL_BLOCK, 1);
      const size = 32768;

      // Fill the single allowed block
      tinyPool.allocateAndCopy(new Uint8Array(size), 'img:1');
      tinyPool.allocateAndCopy(new Uint8Array(size), 'img:2');

      // Next allocation exceeds maxBlocks, should return the original source
      const source = new Uint8Array(size);
      source[0] = 77;
      const result = tinyPool.allocateAndCopy(source, 'img:3');

      // Fallback: returns the original source array
      expect(result).toBe(source);
      expect(result[0]).toBe(77);

      tinyPool.destroy();
    });
  });

  describe('alignment', () => {
    it('should properly align Uint16Array allocations', () => {
      // Allocate an odd-sized Uint8Array first to potentially misalign
      const odd = new Uint8Array(3);
      pool.allocateAndCopy(odd, 'img:odd');

      // Uint16 requires 2-byte alignment
      const aligned = new Uint16Array([0xbeef, 0xcafe]);
      const result = pool.allocateAndCopy(aligned, 'img:aligned');

      expect(result[0]).toBe(0xbeef);
      expect(result[1]).toBe(0xcafe);
    });

    it('should properly align Float32Array allocations', () => {
      const odd = new Uint8Array(5);
      pool.allocateAndCopy(odd, 'img:odd');

      // Float32 requires 4-byte alignment
      const aligned = new Float32Array([3.14, 2.72]);
      const result = pool.allocateAndCopy(aligned, 'img:f32-aligned');

      expect(result[0]).toBeCloseTo(3.14);
      expect(result[1]).toBeCloseTo(2.72);
    });
  });

  describe('destroy', () => {
    it('should clear all allocations and blocks', () => {
      pool.allocateAndCopy(new Uint8Array(100), 'img:1');
      pool.allocateAndCopy(new Uint8Array(100), 'img:2');

      pool.destroy();

      expect(pool.getAllocationCount()).toBe(0);
      expect(pool.getAllocatedBytes()).toBe(0);
    });
  });

  describe('allocation larger than blockSize', () => {
    it('should fall back to JS-heap when allocation exceeds configured blockSize', () => {
      // Pool has 64 KiB blocks — an allocation larger than that should
      // respect the user's configured limit and fall back gracefully
      const oversized = new Uint8Array(SMALL_BLOCK + 1024);
      oversized[0] = 11;

      const result = pool.allocateAndCopy(oversized, 'img:oversized');

      // Should return the original source (fallback), not a WASM-backed copy
      expect(result).toBe(oversized);
      expect(pool.getAllocationCount()).toBe(0);
    });
  });

  describe('free after destroy', () => {
    it('should handle free gracefully when blocks have been cleared', () => {
      pool.allocateAndCopy(new Uint8Array(100), 'img:1');

      // Manually clear blocks to simulate destroyed state while allocation map still has entries
      pool.destroy();

      // Should not throw
      pool.free('img:1');
    });
  });

  describe('data integrity on reuse', () => {
    it('should not leak data from a previous allocation into a new one', () => {
      const first = new Uint8Array(64);
      first.fill(0xff);
      pool.allocateAndCopy(first, 'img:first');
      pool.free('img:first');

      // Allocate same size with zeroes — should not contain old 0xFF data
      const second = new Uint8Array(64);
      second.fill(0);
      const result = pool.allocateAndCopy(second, 'img:second');

      expect(result.every((v) => v === 0)).toBe(true);
    });
  });

  describe('getMaxCapacity', () => {
    it('should return blockSize * maxBlocks', () => {
      expect(pool.getMaxCapacity()).toBe(SMALL_BLOCK * 4);
    });

    it('should reflect custom block size and max blocks', () => {
      const customPool = new OffHeapMemoryPool(1024 * 1024, 8);
      expect(customPool.getMaxCapacity()).toBe(1024 * 1024 * 8);
      customPool.destroy();
    });
  });

  describe('getAllocatedBytes', () => {
    it('should track total allocated bytes accurately', () => {
      const a = new Uint16Array(100); // 200 bytes
      const b = new Float32Array(50); // 200 bytes

      pool.allocateAndCopy(a, 'img:a');
      expect(pool.getAllocatedBytes()).toBe(200);

      pool.allocateAndCopy(b, 'img:b');
      expect(pool.getAllocatedBytes()).toBe(400);

      pool.free('img:a');
      expect(pool.getAllocatedBytes()).toBe(200);

      pool.free('img:b');
      expect(pool.getAllocatedBytes()).toBe(0);
    });
  });
});
