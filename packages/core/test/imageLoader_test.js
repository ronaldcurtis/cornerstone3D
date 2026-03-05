import {
  cleanupTestEnvironment,
  setupTestEnvironment,
} from '../../../utils/test/testUtils';
import * as cornerstone3D from '../src/index';
import { OffHeapMemoryPool } from '../src/cache/OffHeapMemoryPool';

const { imageLoader, cache, utilities, Enums } = cornerstone3D;
const { VoxelManager } = utilities;

describe('imageLoader -- ', function () {
  afterEach(() => {
    cleanupTestEnvironment();
  });

  beforeEach(function () {
    setupTestEnvironment();
    const [rows1, columns1] = [100, 100];
    const scalarData1 = new Uint8Array(rows1[0] * columns1[1]);
    this.image1 = {
      imageId: 'image1',
      getPixelData: scalarData1,
      sizeInBytes: scalarData1.byteLength,
      rows: rows1,
      columns: columns1,
    };

    this.exampleImageLoader1 = (imageId, options) => {
      console.log('loading via exampleImageLoader1');
      console.log(options);

      return {
        promise: Promise.resolve(this.image1),
        cancelFn: undefined,
      };
    };

    // Another image loader
    const [rows2, columns2] = [200, 200];
    const scalarData2 = new Uint8Array(rows2[0] * columns2[1]);

    this.image2 = {
      imageId: 'image2',
      getPixelData: scalarData2,
      sizeInBytes: scalarData2.byteLength,
      rows: rows2,
      columns: columns2,
    };

    this.exampleImageLoader2 = (imageId, options) => {
      console.log('loading via exampleImageLoader2');
      console.log(options);

      return {
        promise: Promise.resolve(this.image2),
        cancelFn: undefined,
      };
    };

    this.exampleScheme1 = 'example1';
    this.exampleScheme2 = 'example2';

    this.exampleScheme1ImageId = `${this.exampleScheme1}://image1`;
    this.exampleScheme2ImageId = `${this.exampleScheme2}://image2`;
  });

  describe('imageLoader registration module', function () {
    it('allows registration of new image loader', async function () {
      imageLoader.registerImageLoader(
        this.exampleScheme1,
        this.exampleImageLoader1
      );
      imageLoader.registerImageLoader(
        this.exampleScheme2,
        this.exampleImageLoader2
      );

      await imageLoader.loadAndCacheImage(
        this.exampleScheme1ImageId,
        this.options
      );

      await imageLoader.loadAndCacheImage(
        this.exampleScheme2ImageId,
        this.options
      );

      expect(
        cache.getImageLoadObject(this.exampleScheme1ImageId)
      ).toBeDefined();
      expect(
        cache.getImageLoadObject(this.exampleScheme2ImageId)
      ).toBeDefined();
    });

    it('allows registration of unknown image loader', function () {
      let oldUnknownImageLoader = imageLoader.registerUnknownImageLoader(
        this.exampleImageLoader1
      );

      expect(oldUnknownImageLoader).not.toBeDefined();

      // Check that it returns the old value for the unknown image loader
      oldUnknownImageLoader = imageLoader.registerUnknownImageLoader(
        this.exampleImageLoader1
      );

      expect(oldUnknownImageLoader).toBe(this.exampleImageLoader1);
    });
  });

  describe('imageLoader loading module', function () {
    it('allows loading with storage in image cache (loadImage)', async function () {
      imageLoader.registerImageLoader(
        this.exampleScheme1,
        this.exampleImageLoader1
      );
      const imageLoadObject = imageLoader.loadAndCacheImage(
        this.exampleScheme1ImageId,
        this.options
      );

      await expectAsync(imageLoadObject).toBeResolvedTo(this.image1);
    });

    it('allows loading without storage in image cache (imageLoader.loadAndCacheImage)', async function () {
      imageLoader.registerImageLoader(
        this.exampleScheme2,
        this.exampleImageLoader2
      );
      const imageLoadObject = imageLoader.loadImage(
        this.exampleScheme2ImageId,
        this.options
      );

      await expectAsync(imageLoadObject).toBeResolvedTo(this.image2);
    });

    it('falls back to the unknownImageLoader if no appropriate scheme is present', async function () {
      imageLoader.registerImageLoader(
        this.exampleScheme1,
        this.exampleImageLoader1
      );
      imageLoader.registerUnknownImageLoader(this.exampleImageLoader2);
      const imageLoadObject = imageLoader.loadAndCacheImage(
        this.exampleScheme2ImageId,
        this.options
      );

      await expectAsync(imageLoadObject).toBeResolvedTo(this.image2);
    });
  });

  describe('imageLoader cancelling images', function () {
    it('allows loading with storage in image cache (imageLoader.loadAndCacheImage)', async function () {
      imageLoader.registerImageLoader(
        this.exampleScheme1,
        this.exampleImageLoader1
      );
      const imageLoadObject = imageLoader.loadAndCacheImage(
        this.exampleScheme1ImageId,
        this.options
      );

      await expectAsync(imageLoadObject).toBeResolvedTo(this.image1);
    });
  });

  describe('off-heap migration when voxelManager already exists', function () {
    let pool;

    beforeEach(function () {
      pool = new OffHeapMemoryPool(65536, 4);
      cache.setOffHeapPool(pool);
    });

    afterEach(function () {
      cache.setOffHeapPool(null);
      pool.destroy();
    });

    it('should migrate pre-existing voxelManager scalar data to off-heap', async function () {
      const width = 4;
      const height = 4;
      const originalData = new Uint16Array(width * height);
      originalData[0] = 42;
      originalData[15] = 99;

      // Simulate DICOM loader behavior: image already has a voxelManager
      const preExistingVoxelManager = VoxelManager.createImageVoxelManager({
        scalarData: originalData,
        width,
        height,
        numberOfComponents: 1,
      });

      const imageId = 'offheap-migrate://test1';
      const image = {
        imageId,
        width,
        height,
        numberOfComponents: 1,
        sizeInBytes: originalData.byteLength,
        voxelManager: preExistingVoxelManager,
        getPixelData: () => preExistingVoxelManager.getScalarData(),
      };

      const loader = () => ({
        promise: Promise.resolve(image),
        cancelFn: undefined,
      });

      imageLoader.registerImageLoader('offheap-migrate', loader);
      await imageLoader.loadAndCacheImage(imageId);

      // Wait for handleImageLoadPromise to run (async)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Pool should have an allocation for this imageId
      expect(pool.getAllocationCount()).toBe(1);

      // The voxelManager's data should have the correct values
      const migratedData = image.voxelManager.getScalarData();
      expect(migratedData[0]).toBe(42);
      expect(migratedData[15]).toBe(99);

      // The migrated data should not be the original JS-heap array
      expect(migratedData).not.toBe(originalData);
    });

    it('should create voxelManager with off-heap data when none exists', async function () {
      const width = 4;
      const height = 4;
      const pixelData = new Uint8Array(width * height);
      pixelData[0] = 11;
      pixelData[15] = 22;

      const imageId = 'offheap-create://test2';
      const image = {
        imageId,
        width,
        height,
        numberOfComponents: 1,
        sizeInBytes: pixelData.byteLength,
        getPixelData: () => pixelData,
        imageFrame: { pixelData },
      };

      const loader = () => ({
        promise: Promise.resolve(image),
        cancelFn: undefined,
      });

      imageLoader.registerImageLoader('offheap-create', loader);
      await imageLoader.loadAndCacheImage(imageId);

      // Wait for handleImageLoadPromise to run (async)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Pool should have an allocation
      expect(pool.getAllocationCount()).toBe(1);

      // voxelManager should have been created
      expect(image.voxelManager).toBeDefined();

      const scalarData = image.voxelManager.getScalarData();
      expect(scalarData[0]).toBe(11);
      expect(scalarData[15]).toBe(22);
      expect(scalarData).not.toBe(pixelData);
    });

    it('should not migrate when no off-heap pool is set', async function () {
      // Remove the pool
      cache.setOffHeapPool(null);

      const width = 4;
      const height = 4;
      const originalData = new Uint16Array(width * height);
      originalData[0] = 7;

      const preExistingVoxelManager = VoxelManager.createImageVoxelManager({
        scalarData: originalData,
        width,
        height,
        numberOfComponents: 1,
      });

      const imageId = 'offheap-noop://test3';
      const image = {
        imageId,
        width,
        height,
        numberOfComponents: 1,
        sizeInBytes: originalData.byteLength,
        voxelManager: preExistingVoxelManager,
        getPixelData: () => preExistingVoxelManager.getScalarData(),
      };

      const loader = () => ({
        promise: Promise.resolve(image),
        cancelFn: undefined,
      });

      imageLoader.registerImageLoader('offheap-noop', loader);
      await imageLoader.loadAndCacheImage(imageId);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Data should remain the same JS-heap array
      expect(image.voxelManager.getScalarData()).toBe(originalData);
      expect(pool.getAllocationCount()).toBe(0);
    });
  });
});
