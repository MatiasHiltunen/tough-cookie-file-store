import { Cookie } from 'tough-cookie';

export interface ICookieSerializer {
  serialize(cookie: Cookie): any;
  deserialize(data: any): Cookie | undefined;
}