import { Cookie } from 'tough-cookie';

export interface ICookieStorage {
  // Synchronous methods
  findCookieSync(domain: string, path: string, key: string): Cookie | undefined;
  findCookiesSync(domain: string, path: string | null, allowSpecialUseDomain?: boolean): Cookie[];
  putCookieSync(cookie: Cookie): void;
  updateCookieSync(oldCookie: Cookie, newCookie: Cookie): void;
  removeCookieSync(domain: string, path: string, key: string): void;
  removeCookiesSync(domain: string, path?: string | null): void;
  removeAllCookiesSync(): void;
  getAllCookiesSync(): Cookie[];

  // Asynchronous methods
  findCookie(domain: string, path: string, key: string): Promise<Cookie | undefined>;
  findCookies(domain: string, path: string | null, allowSpecialUseDomain?: boolean): Promise<Cookie[]>;
  putCookie(cookie: Cookie): Promise<void>;
  updateCookie(oldCookie: Cookie, newCookie: Cookie): Promise<void>;
  removeCookie(domain: string, path: string, key: string): Promise<void>;
  removeCookies(domain: string, path?: string | null): Promise<void>;
  removeAllCookies(): Promise<void>;
  getAllCookies(): Promise<Cookie[]>;
}