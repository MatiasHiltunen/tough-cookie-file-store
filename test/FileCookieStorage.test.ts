import { FileCookieStorage } from '../lib/FileCookieStorage';
import { Cookie } from 'tough-cookie';
import * as fs from 'fs';
import * as path from 'path';

describe('FileCookieStorage', () => {
  const testDir = path.resolve(__dirname, 'test_data');
  const testFilePath = path.join(testDir, 'test-cookies.json');
  const emptyFilePath = path.join(__dirname, 'cookies-empty.json');
  const parseErrorFilePath = path.join(__dirname, 'cookies-parse-error.json');
  const validCookiesFilePath = path.join(__dirname, 'cookies.json');

  beforeAll(() => {
    // Ensure test directory exists
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }
  });

  afterEach(() => {
    // Clean up test cookie file after each test
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe('Initialization', () => {
    test('should initialize with empty store when file does not exist', async () => {
      const storage = new FileCookieStorage({ filePath: testFilePath });

      const cookies = await storage.getAllCookies();
      expect(cookies).toEqual([]);
    });

    test('should initialize with empty store when file is empty', async () => {
      // Copy empty file to testFilePath
      fs.copyFileSync(emptyFilePath, testFilePath);

      const storage = new FileCookieStorage({ filePath: testFilePath });


      const cookies = await storage.getAllCookies();
      expect(cookies).toEqual([]);
    });

    test('should handle parse error gracefully and start with empty store', async () => {
      // Copy parse error file to testFilePath
      fs.copyFileSync(parseErrorFilePath, testFilePath);

      const storage = new FileCookieStorage({ filePath: testFilePath });
   

      const cookies = await storage.getAllCookies();
      expect(cookies).toEqual([]);
    });

    test('should initialize with existing cookies from file', async () => {
      // Copy valid cookies file to testFilePath
      fs.copyFileSync(validCookiesFilePath, testFilePath);

      const storage = new FileCookieStorage({ filePath: testFilePath });


      const cookies = await storage.getAllCookies();
      expect(cookies.length).toBeGreaterThan(0);

      const cookieKeys = cookies.map((cookie) => cookie.key);
      expect(cookieKeys).toContain('testKey');
    });
  });

  describe('Cookie Storage and Retrieval', () => {
    let storage: FileCookieStorage;

    beforeEach(async () => {
      storage = new FileCookieStorage({ filePath: testFilePath, debounceDelay: 100 });

    });

    test('should store and retrieve a cookie', async () => {
      const cookie = new Cookie({
        key: 'testKey',
        value: 'testValue',
        domain: 'example.com',
        path: '/',
      });

      await storage.putCookie(cookie);

      const retrievedCookie = await storage.findCookie('example.com', '/', 'testKey');
      expect(retrievedCookie).toBeDefined();
      expect(retrievedCookie!.value).toBe('testValue');
    });

    test('should update an existing cookie', async () => {
      const cookie = new Cookie({
        key: 'testKey',
        value: 'testValue',
        domain: 'example.com',
        path: '/',
      });

      await storage.putCookie(cookie);

      const updatedCookie = new Cookie({
        key: 'testKey',
        value: 'updatedValue',
        domain: 'example.com',
        path: '/',
      });

      await storage.updateCookie(cookie, updatedCookie);

      const retrievedCookie = await storage.findCookie('example.com', '/', 'testKey');
      expect(retrievedCookie).toBeDefined();
      expect(retrievedCookie!.value).toBe('updatedValue');
    });

    test('should remove a cookie', async () => {
      const cookie = new Cookie({
        key: 'testKey',
        value: 'testValue',
        domain: 'example.com',
        path: '/',
      });

      await storage.putCookie(cookie);
      await storage.removeCookie('example.com', '/', 'testKey');

      const retrievedCookie = await storage.findCookie('example.com', '/', 'testKey');
      expect(retrievedCookie).toBeUndefined();
    });

    test('should retrieve all cookies for a domain and path', async () => {
      const cookie1 = new Cookie({
        key: 'key1',
        value: 'value1',
        domain: 'example.com',
        path: '/path1',
      });

      const cookie2 = new Cookie({
        key: 'key2',
        value: 'value2',
        domain: 'example.com',
        path: '/path2',
      });

      await storage.putCookie(cookie1);
      await storage.putCookie(cookie2);

      const cookies = await storage.findCookies('example.com', null);
      expect(cookies.length).toBe(2);

      const path1Cookies = await storage.findCookies('example.com', '/path1');
      expect(path1Cookies.length).toBe(1);
      expect(path1Cookies[0].key).toBe('key1');
    });

    test('should remove all cookies for a domain', async () => {
      const cookie1 = new Cookie({
        key: 'key1',
        value: 'value1',
        domain: 'example.com',
        path: '/path1',
      });

      const cookie2 = new Cookie({
        key: 'key2',
        value: 'value2',
        domain: 'example.com',
        path: '/path2',
      });

      await storage.putCookie(cookie1);
      await storage.putCookie(cookie2);

      await storage.removeCookies('example.com');

      const cookies = await storage.findCookies('example.com', null);
      expect(cookies.length).toBe(0);
    });

    test('should remove all cookies', async () => {
      const cookie1 = new Cookie({
        key: 'key1',
        value: 'value1',
        domain: 'example.com',
        path: '/path1',
      });

      const cookie2 = new Cookie({
        key: 'key2',
        value: 'value2',
        domain: 'another.com',
        path: '/',
      });

      await storage.putCookie(cookie1);
      await storage.putCookie(cookie2);

      await storage.removeAllCookies();

      const cookies = await storage.getAllCookies();
      expect(cookies.length).toBe(0);
    });
  });

  describe('Worker Thread Functionality', () => {
    let storage: FileCookieStorage;

    beforeEach(async () => {
      storage = new FileCookieStorage({ filePath: testFilePath, useWorker: true, debounceDelay: 100 });
      await storage.init();
    });

    afterEach(async () => {
      await storage.flushData();
    });

    test('should store and retrieve a cookie using worker thread', async () => {
      const cookie = new Cookie({
        key: 'workerKey',
        value: 'workerValue',
        domain: 'worker.com',
        path: '/',
      });

      await storage.putCookie(cookie);

      const retrievedCookie = await storage.findCookie('worker.com', '/', 'workerKey');
      expect(retrievedCookie).toBeDefined();
      expect(retrievedCookie!.value).toBe('workerValue');
    });

    test('should flush data before process exit', async () => {
      const cookie = new Cookie({
        key: 'flushKey',
        value: 'flushValue',
        domain: 'worker.com',
        path: '/',
      });

      await storage.putCookie(cookie);

      // Manually trigger flush
      await storage.flushData();

      // Create a new instance to read from the file
      const newStorage = new FileCookieStorage({ filePath: testFilePath, useWorker: false });
      await newStorage.init();

      const retrievedCookie = await newStorage.findCookie('worker.com', '/', 'flushKey');
      expect(retrievedCookie).toBeDefined();
      expect(retrievedCookie!.value).toBe('flushValue');
    });
  });

  describe('Error Handling', () => {
    test('should throw error when invalid file path is provided', () => {
      expect(() => {
        new FileCookieStorage({ filePath: '' });
      }).toThrow();
    });

    test('should handle corrupted JSON file gracefully', async () => {
      // Copy parse error file to testFilePath
      fs.copyFileSync(parseErrorFilePath, testFilePath);

      const storage = new FileCookieStorage({ filePath: testFilePath });
      await storage.init();

      const cookies = await storage.getAllCookies();
      expect(cookies.length).toBe(0);
    });
  });

  describe('Serialization and Deserialization', () => {
    test('should correctly serialize and deserialize cookies', async () => {
      const storage = new FileCookieStorage({ filePath: testFilePath });
      await storage.init();

      const cookie = new Cookie({
        key: 'serializeKey',
        value: 'serializeValue',
        domain: 'serialize.com',
        path: '/',
        expires: new Date('2030-01-01T00:00:00Z'),
        httpOnly: true,
        secure: true,
        creation: new Date(),
        lastAccessed: new Date(),
      });

      await storage.putCookie(cookie);

      // Read the file directly to check serialization
      const data = fs.readFileSync(testFilePath, 'utf8');
      const jsonData = JSON.parse(data);

      expect(jsonData['serialize.com']).toBeDefined();
      expect(jsonData['serialize.com']['/']['serializeKey']).toBeDefined();

      const serializedCookie = jsonData['serialize.com']['/']['serializeKey'];
      expect(serializedCookie.key).toBe('serializeKey');
      expect(serializedCookie.value).toBe('serializeValue');
      expect(serializedCookie.domain).toBe('serialize.com');
      expect(serializedCookie.path).toBe('/');
      expect(serializedCookie.expires).toBe('2030-01-01T00:00:00.000Z');
      expect(serializedCookie.httpOnly).toBe(true);
      expect(serializedCookie.secure).toBe(true);

      // Deserialize and check properties
      const retrievedCookie = await storage.findCookie('serialize.com', '/', 'serializeKey');
      expect(retrievedCookie).toBeDefined();
      expect(retrievedCookie!.key).toBe('serializeKey');
      expect(retrievedCookie!.value).toBe('serializeValue');
      expect(retrievedCookie!.domain).toBe('serialize.com');
      expect(retrievedCookie!.path).toBe('/');
      // @ts-ignore
      expect(retrievedCookie!.expires!.toISOString()).toBe('2030-01-01T00:00:00.000Z');
      expect(retrievedCookie!.httpOnly).toBe(true);
      expect(retrievedCookie!.secure).toBe(true);
    });
  });

  describe('Synchronous Methods', () => {
    let storage: FileCookieStorage;

    beforeEach(() => {
      storage = new FileCookieStorage({ filePath: testFilePath });
      storage.initSync();
    });

    test('should store and retrieve a cookie synchronously', () => {
      const cookie = new Cookie({
        key: 'syncKey',
        value: 'syncValue',
        domain: 'sync.com',
        path: '/',
      });

      storage.putCookieSync(cookie);

      const retrievedCookie = storage.findCookieSync('sync.com', '/', 'syncKey');
      expect(retrievedCookie).toBeDefined();
      expect(retrievedCookie!.value).toBe('syncValue');
    });

    test('should retrieve all cookies synchronously', () => {
      const cookie1 = new Cookie({
        key: 'syncKey1',
        value: 'syncValue1',
        domain: 'sync.com',
        path: '/',
      });

      const cookie2 = new Cookie({
        key: 'syncKey2',
        value: 'syncValue2',
        domain: 'sync.com',
        path: '/path',
      });

      storage.putCookieSync(cookie1);
      storage.putCookieSync(cookie2);

      const cookies = storage.getAllCookiesSync();
      expect(cookies.length).toBe(2);

      const cookieKeys = cookies.map((cookie) => cookie.key);
      expect(cookieKeys).toContain('syncKey1');
      expect(cookieKeys).toContain('syncKey2');
    });
  });
});