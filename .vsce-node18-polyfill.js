'use strict';

if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends Blob {};
}
