/* The one place a version number lives. app.js prints it in the status strip
   and hands it to the service worker as a cache key, so a release cannot ship
   with the page and the cache disagreeing about which build they are. */

export const VERSION = "0.1.0";
export const RELEASED = "2026-08-09";
