import { ICookieSerializer } from './ICookieSerializer';
import { Cookie } from 'tough-cookie';

export class DefaultCookieSerializer implements ICookieSerializer {
  serialize(cookie: Cookie): any {
    return cookie.toJSON();
  }

  deserialize(data: any): Cookie | undefined {
    try {
      return Cookie.fromJSON(data);
    } catch {
      return undefined;
    }
  }
}