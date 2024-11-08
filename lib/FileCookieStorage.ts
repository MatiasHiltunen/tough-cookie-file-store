import { ICookieStorage } from './ICookieStorage';
import { ICookieSerializer } from './ICookieSerializer';
import { DefaultCookieSerializer } from './DefaultCookieSerializer';
import { Cookie, permuteDomain, pathMatch } from 'tough-cookie';
import * as fs from 'fs';
import * as path from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { EventEmitter } from 'events';

type DomainIndex = Map<string, PathIndex>;
type PathIndex = Map<string, Cookie>;

interface FileCookieStorageOptions {
    filePath?: string;
    serializer?: ICookieSerializer;
    debounceDelay?: number;
    useWorker?: boolean;
}

interface WorkerMessage {
    type: string;
    data?: any;
}

export class FileCookieStorage extends EventEmitter implements ICookieStorage {
    private idx: Map<string, DomainIndex> = new Map();
    private readonly filePath: string;
    readonly serializer: ICookieSerializer;
    private isInitialized: boolean = false;
    private writePending: boolean = false;
    private debounceTimeout: NodeJS.Timeout | null = null;
    private readonly debounceDelay: number;
    private readonly useWorker: boolean;
    private worker: Worker | null = null;
    private pendingPromises: Map<number, { resolve: Function; reject: Function }> = new Map();
    private messageIdCounter: number = 0;

    constructor(options: FileCookieStorageOptions = {}) {
        super();
        this.filePath = options.filePath || path.resolve('cookies.json');
        this.serializer = options.serializer || new DefaultCookieSerializer();
        this.debounceDelay = options.debounceDelay ?? 2000;
        this.useWorker = options.useWorker ?? false;

        if (this.useWorker) {
            this.startWorker();
        } else {
            this.init().catch((err) => {
                console.error('Error initializing FileCookieStorage:', err);
            });
        }

        this.setupExitHandlers();
    }

    // Worker thread initialization
    private startWorker() {
        this.worker = new Worker(__filename, {
            workerData: {
                filePath: this.filePath,
                debounceDelay: this.debounceDelay,
            },
        });

        this.worker.on('message', (message: WorkerMessage) => this.handleWorkerMessage(message));
        this.worker.on('error', (err) => {
            console.error('Worker error:', err);
        });
        this.worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Worker stopped with exit code ${code}`);
            }
        });
    }

    // Handle messages from worker
    private handleWorkerMessage(message: WorkerMessage) {
        if (message.type === 'response') {
            const { id, result, error } = message.data;
            const pending = this.pendingPromises.get(id);
            if (pending) {
                if (error) {
                    pending.reject(new Error(error));
                } else {
                    pending.resolve(result);
                }
                this.pendingPromises.delete(id);
            }
        } else if (message.type === 'event' && message.data === 'flushed') {
            this.emit('flushed');
        }
    }

    // Send a message to the worker and return a promise
    private sendWorkerMessage(type: string, data?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.messageIdCounter++;
            this.pendingPromises.set(id, { resolve, reject });
            this.worker!.postMessage({ type, data: { id, data } });
        });
    }

    // Process exit handlers to ensure data is flushed
    private setupExitHandlers() {
        const flushData = () => {
            if (this.useWorker) {
                return this.sendWorkerMessage('flush');
            } else {
                return this.flushData();
            }
        };

        const exitHandler = (options: { exit?: boolean }) => {
            flushData()
                .then(() => {
                    if (options.exit) process.exit();
                })
                .catch((err) => {
                    console.error('Error flushing data on exit:', err);
                    if (options.exit) process.exit(1);
                });
        };

        process.on('exit', exitHandler.bind(null, {}));
        process.on('SIGINT', exitHandler.bind(null, { exit: true }));
        process.on('SIGTERM', exitHandler.bind(null, { exit: true }));
        process.on('uncaughtException', exitHandler.bind(null, { exit: true }));
    }

    // Initialization
    async init(): Promise<void> {
        if (this.isInitialized) return;

        try {
            if (!fs.existsSync(this.filePath)) {
                this.idx = new Map();
            } else {
                const data = await fs.promises.readFile(this.filePath, 'utf8');
                if (data) {
                    const dataJson = JSON.parse(data);
                    this.idx = this.deserializeCookies(dataJson);
                } else {
                    this.idx = new Map();
                }
            }
        } catch (e) {
            console.warn(`Could not parse cookie file ${this.filePath}. Starting with an empty store.`);
            this.idx = new Map();
        }

        this.isInitialized = true;
    }

    private scheduleSaveToFile(): void {
        if (this.writePending) return;

        this.writePending = true;

        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }

        this.debounceTimeout = setTimeout(() => {
            if (this.useWorker) {
                this.sendWorkerMessage('save').catch((err) => {
                    console.error('Error saving cookies in worker:', err);
                });
            } else {
                this.saveToFile().catch((err) => {
                    console.error('Error saving cookies to file:', err);
                });
            }
        }, this.debounceDelay);
    }

    private async saveToFile(): Promise<void> {
        this.writePending = false;

        const dataToSave = this.serializeCookies(this.idx);

        // Ensure directory exists
        const dir = path.dirname(this.filePath);
        await fs.promises.mkdir(dir, { recursive: true });

        try {
            await fs.promises.writeFile(this.filePath, JSON.stringify(dataToSave, null, 2), 'utf8');
        } catch (err) {
            console.error('Error writing cookies to file:', err);
        }
    }

    public async flushData(): Promise<void> {
        if (this.writePending) {
            if (this.debounceTimeout) {
                clearTimeout(this.debounceTimeout);
                this.debounceTimeout = null;
            }
            if (this.useWorker) {
                await this.sendWorkerMessage('save');
            } else {
                await this.saveToFile();
            }
        }
    }

    // Serialization and Deserialization
    private deserializeCookies(dataJson: any): Map<string, DomainIndex> {
        const idx = new Map<string, DomainIndex>();

        for (const domainName in dataJson) {
            const domainData = dataJson[domainName];
            if (typeof domainData !== 'object') continue;

            const domainIndex = new Map<string, PathIndex>();
            idx.set(domainName, domainIndex);

            for (const pathName in domainData) {
                const pathData = domainData[pathName];
                if (typeof pathData !== 'object') continue;

                const pathIndex = new Map<string, Cookie>();
                domainIndex.set(pathName, pathIndex);

                for (const cookieName in pathData) {
                    const cookieData = pathData[cookieName];
                    const cookie = this.serializer.deserialize(cookieData);
                    if (cookie) {
                        pathIndex.set(cookieName, cookie);
                    } else {
                        console.warn(`Could not parse cookie: ${cookieName} in ${domainName}${pathName}`);
                    }
                }
            }
        }

        return idx;
    }

    private serializeCookies(idx: Map<string, DomainIndex>): any {
        const dataToSave: any = {};

        for (const [domainName, domainIndex] of idx.entries()) {
            const domainOutput: any = {};
            dataToSave[domainName] = domainOutput;

            for (const [pathName, pathIndex] of domainIndex.entries()) {
                const pathOutput: any = {};
                domainOutput[pathName] = pathOutput;

                for (const [cookieName, cookie] of pathIndex.entries()) {
                    pathOutput[cookieName] = this.serializer.serialize(cookie);
                }
            }
        }

        return dataToSave;
    }

    // Helper methods
    private async getDomainIndex(domain: string): Promise<DomainIndex> {
        await this.init();

        if (!this.idx.has(domain)) {
            this.idx.set(domain, new Map());
        }
        return this.idx.get(domain)!;
    }

    private async getPathIndex(domain: string, path: string): Promise<PathIndex> {
        const domainIndex = await this.getDomainIndex(domain);

        if (!domainIndex.has(path)) {
            domainIndex.set(path, new Map());
        }
        return domainIndex.get(path)!;
    }

    private getCookieFromIndex(domainIndex: DomainIndex, path: string, key: string): Cookie | undefined {
        const pathIndex = domainIndex.get(path);
        if (!pathIndex) return undefined;
        return pathIndex.get(key);
    }

    private async addCookieToIndex(cookie: Cookie): Promise<void> {
        const domain = cookie.domain!;
        const path = cookie.path!;
        const key = cookie.key;

        let domainIndex = this.idx.get(domain);
        if (!domainIndex) {
            domainIndex = new Map();
            this.idx.set(domain, domainIndex);
        }

        let pathIndex = domainIndex.get(path);
        if (!pathIndex) {
            pathIndex = new Map();
            domainIndex.set(path, pathIndex);
        }

        pathIndex.set(key, cookie);
    }

    private removeCookieFromIndex(domain: string, path: string, key: string): void {
        const domainIndex = this.idx.get(domain);
        if (!domainIndex) return;

        const pathIndex = domainIndex.get(path);
        if (!pathIndex) return;

        pathIndex.delete(key);

        if (pathIndex.size === 0) {
            domainIndex.delete(path);
        }
        if (domainIndex.size === 0) {
            this.idx.delete(domain);
        }
    }

    private removeCookiesFromIndex(domain: string, path?: string | null): void {
        const domainIndex = this.idx.get(domain);
        if (!domainIndex) return;

        if (path) {
            domainIndex.delete(path);
            if (domainIndex.size === 0) {
                this.idx.delete(domain);
            }
        } else {
            this.idx.delete(domain);
        }
    }

    private getAllCookiesFromIndex(): Cookie[] {
        const cookies: Cookie[] = [];

        for (const domainIndex of this.idx.values()) {
            for (const pathIndex of domainIndex.values()) {
                cookies.push(...pathIndex.values());
            }
        }

        cookies.sort((a, b) => {

            let time_a: number = a.creation === 'Infinity' ? Infinity : a.creation?.getTime() ?? 0
            let time_b: number = b.creation === 'Infinity' ? Infinity : b.creation?.getTime() ?? 0

            return time_a - time_b;
        });

        return cookies;
    }

    private async findCookiesInIndex(domain: string, path: string | null, allowSpecialUseDomain: boolean): Promise<Cookie[]> {
        const results: Cookie[] = [];
        if (!domain) return results;

        const domains = permuteDomain(domain, allowSpecialUseDomain) || [domain];

        for (const curDomain of domains) {
            const domainIndex = this.idx.get(curDomain);
            if (!domainIndex) continue;

            if (!path) {
                for (const pathIndex of domainIndex.values()) {
                    results.push(...pathIndex.values());
                }
            } else {
                for (const [cookiePath, pathIndex] of domainIndex.entries()) {
                    if (!pathMatch(path, cookiePath)) continue;
                    results.push(...pathIndex.values());
                }
            }
        }

        return results;
    }

    // Synchronous methods
    public findCookieSync(domain: string, path: string, key: string): Cookie | undefined {
        this.initSync();

        const domainIndex = this.idx.get(domain);
        if (!domainIndex) return undefined;

        return this.getCookieFromIndex(domainIndex, path, key);
    }

    public findCookiesSync(domain: string, path: string | null, allowSpecialUseDomain: boolean = false): Cookie[] {
        this.initSync();

        return this.findCookiesSync(domain, path, allowSpecialUseDomain);
    }

    public putCookieSync(cookie: Cookie): void {
        this.initSync();

        this.addCookieToIndex(cookie);
        this.scheduleSaveToFile();
    }

    public updateCookieSync(_oldCookie: Cookie, newCookie: Cookie): void {
        this.putCookieSync(newCookie);
    }

    public removeCookieSync(domain: string, path: string, key: string): void {
        this.initSync();

        this.removeCookieFromIndex(domain, path, key);
        this.scheduleSaveToFile();
    }

    public removeCookiesSync(domain: string, path?: string | null): void {
        this.initSync();

        this.removeCookiesFromIndex(domain, path);
        this.scheduleSaveToFile();
    }

    public removeAllCookiesSync(): void {
        this.initSync();

        this.idx.clear();
        this.scheduleSaveToFile();
    }

    public getAllCookiesSync(): Cookie[] {
        this.initSync();

        return this.getAllCookiesFromIndex();
    }

    // Asynchronous methods
    public async findCookie(domain: string, path: string, key: string): Promise<Cookie | undefined> {
        if (this.useWorker) {
            const result = await this.sendWorkerMessage('findCookie', { domain, path, key });
            return result ? this.serializer.deserialize(result) : undefined;
        }

        await this.init();

        const domainIndex = this.idx.get(domain);
        if (!domainIndex) return undefined;

        return this.getCookieFromIndex(domainIndex, path, key);
    }

    public async findCookies(domain: string, path: string | null, allowSpecialUseDomain: boolean = false): Promise<Cookie[]> {
        if (this.useWorker) {
            const result = await this.sendWorkerMessage('findCookies', { domain, path, allowSpecialUseDomain });
            return result.map((data: any) => this.serializer.deserialize(data));
        }

        await this.init();

        return this.findCookiesInIndex(domain, path, allowSpecialUseDomain);
    }

    public async putCookie(cookie: Cookie): Promise<void> {
        if (this.useWorker) {
            await this.sendWorkerMessage('putCookie', { cookie: this.serializer.serialize(cookie) });
            return;
        }

        await this.init();

        await this.addCookieToIndex(cookie);
        this.scheduleSaveToFile();
    }

    public async updateCookie(_oldCookie: Cookie, newCookie: Cookie): Promise<void> {
        await this.putCookie(newCookie);
    }

    public async removeCookie(domain: string, path: string, key: string): Promise<void> {
        if (this.useWorker) {
            await this.sendWorkerMessage('removeCookie', { domain, path, key });
            return;
        }

        await this.init();

        this.removeCookieFromIndex(domain, path, key);
        this.scheduleSaveToFile();
    }

    public async removeCookies(domain: string, path?: string | null): Promise<void> {
        if (this.useWorker) {
            await this.sendWorkerMessage('removeCookies', { domain, path });
            return;
        }

        await this.init();

        this.removeCookiesFromIndex(domain, path);
        this.scheduleSaveToFile();
    }

    public async removeAllCookies(): Promise<void> {
        if (this.useWorker) {
            await this.sendWorkerMessage('removeAllCookies');
            return;
        }

        await this.init();

        this.idx.clear();
        this.scheduleSaveToFile();
    }

    public async getAllCookies(): Promise<Cookie[]> {
        if (this.useWorker) {
            const result = await this.sendWorkerMessage('getAllCookies');
            return result.map((data: any) => this.serializer.deserialize(data));
        }

        await this.init();

        return this.getAllCookiesFromIndex();
    }

    // Synchronous initialization (used by sync methods)
    initSync(): void {
        if (this.isInitialized) return;

        try {
            if (!fs.existsSync(this.filePath)) {
                this.idx = new Map();
            } else {
                const data = fs.readFileSync(this.filePath, 'utf8');
                if (data) {
                    const dataJson = JSON.parse(data);
                    this.idx = this.deserializeCookies(dataJson);
                } else {
                    this.idx = new Map();
                }
            }
        } catch (e) {
            console.warn(`Could not parse cookie file ${this.filePath}. Starting with an empty store.`);
            this.idx = new Map();
        }

        this.isInitialized = true;
    }
}

// Worker thread code
if (!isMainThread && parentPort) {
    const { filePath, debounceDelay } = workerData;
    const storage = new FileCookieStorage({
        filePath,
        debounceDelay,
        useWorker: false, // Avoid recursive worker creation
    });

    parentPort.on('message', async (message: WorkerMessage) => {
        const { type, data } = message;
        const { id, data: payload } = data;

        try {
            let result;
            switch (type) {
                case 'findCookie':
                    result = await storage.findCookie(payload.domain, payload.path, payload.key);
                    result = result ? storage.serializer.serialize(result) : undefined;
                    break;
                case 'findCookies':
                    result = await storage.findCookies(payload.domain, payload.path, payload.allowSpecialUseDomain);
                    result = result.map((cookie) => storage.serializer.serialize(cookie));
                    break;
                case 'putCookie':
                    const cookieData = payload.cookie;
                    const cookie = storage.serializer.deserialize(cookieData);
                    if (cookie) {
                        await storage.putCookie(cookie);
                    }
                    result = null;
                    break;
                case 'removeCookie':
                    await storage.removeCookie(payload.domain, payload.path, payload.key);
                    result = null;
                    break;
                case 'removeCookies':
                    await storage.removeCookies(payload.domain, payload.path);
                    result = null;
                    break;
                case 'removeAllCookies':
                    await storage.removeAllCookies();
                    result = null;
                    break;
                case 'getAllCookies':
                    result = await storage.getAllCookies();
                    result = result.map((cookie) => storage.serializer.serialize(cookie));
                    break;
                case 'save':
                case 'flush':
                    await storage.flushData();
                    parentPort!.postMessage({ type: 'event', data: 'flushed' });
                    result = null;
                    break;
                default:
                    throw new Error(`Unknown message type: ${type}`);
            }

            parentPort!.postMessage({ type: 'response', data: { id, result } });
        } catch (error:any) {
            parentPort!.postMessage({ type: 'response', data: { id, error: error.toString() } });
        }
    });
}
