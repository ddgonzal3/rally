/**
 * Rally Test Bridge — injected into the WebView in test mode.
 *
 * Exposes window.__rallyTest with methods for test automation.
 * Communicates back to the Rust test server via fetch() to /_result/{id}.
 */
(function () {
  'use strict';

  if (window.__rallyTest) return; // Already injected

  /**
   * Get the Zustand store instance. We look for it on the React fiber tree
   * or, more practically, on the module-level export. The store is created
   * with `create()` and used via `useWorkspaceStore`. We can access its
   * state via `useWorkspaceStore.getState()`, but that reference isn't on
   * `window`. Instead, we inject an accessor from the React app.
   *
   * Fallback: we check for a globally-exposed store (set by the app in test mode).
   */
  function getStoreState() {
    if (window.__rallyStoreAccessor) {
      return window.__rallyStoreAccessor();
    }
    return null;
  }

  function querySelector(selector) {
    return document.querySelector(selector);
  }

  function querySelectorAll(selector) {
    return document.querySelectorAll(selector);
  }

  window.__rallyTest = {
    /**
     * Click an element matching the CSS selector.
     * @param {string} selector
     * @returns {boolean} true if element was found and clicked
     */
    click: function (selector) {
      var el = querySelector(selector);
      if (!el) return false;
      el.click();
      return true;
    },

    /**
     * Type text into an input/textarea matching the selector.
     * Focuses the element, sets value, and dispatches input event.
     * @param {string} selector
     * @param {string} text
     * @returns {boolean}
     */
    type: function (selector, text) {
      var el = querySelector(selector);
      if (!el) return false;
      el.focus();
      // Use native setter to trigger React's onChange
      var nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      );
      if (!nativeSetter) {
        nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        );
      }
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },

    /**
     * Get the full Zustand store state snapshot.
     * @returns {object|null}
     */
    getStoreState: function () {
      return getStoreState();
    },

    /**
     * Get the text content of the first element matching selector.
     * @param {string} selector
     * @returns {string|null}
     */
    getElementText: function (selector) {
      var el = querySelector(selector);
      return el ? el.textContent : null;
    },

    /**
     * Count elements matching selector.
     * @param {string} selector
     * @returns {number}
     */
    getElementCount: function (selector) {
      return querySelectorAll(selector).length;
    },

    /**
     * Check if an element matching selector is visible (not display:none, not hidden).
     * @param {string} selector
     * @returns {boolean}
     */
    isVisible: function (selector) {
      var el = querySelector(selector);
      if (!el) return false;
      var style = window.getComputedStyle(el);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    },

    /**
     * Wait for an element matching selector to appear in the DOM.
     * @param {string} selector
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<boolean>}
     */
    waitForSelector: function (selector, timeoutMs) {
      timeoutMs = timeoutMs || 5000;
      return new Promise(function (resolve) {
        // Check immediately
        if (querySelector(selector)) {
          resolve(true);
          return;
        }
        var elapsed = 0;
        var interval = 100;
        var timer = setInterval(function () {
          elapsed += interval;
          if (querySelector(selector)) {
            clearInterval(timer);
            resolve(true);
          } else if (elapsed >= timeoutMs) {
            clearInterval(timer);
            resolve(false);
          }
        }, interval);
      });
    },

    /**
     * Wait for a Zustand store property to match a value.
     * Path is dot-separated (e.g., "workspaces.length").
     * @param {string} path
     * @param {*} value
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<boolean>}
     */
    waitForStoreCondition: function (path, value, timeoutMs) {
      timeoutMs = timeoutMs || 5000;
      return new Promise(function (resolve) {
        function check() {
          var state = getStoreState();
          if (!state) return false;
          var parts = path.split('.');
          var current = state;
          for (var i = 0; i < parts.length; i++) {
            if (current == null) return false;
            current = current[parts[i]];
          }
          return current === value;
        }

        if (check()) {
          resolve(true);
          return;
        }
        var elapsed = 0;
        var interval = 100;
        var timer = setInterval(function () {
          elapsed += interval;
          if (check()) {
            clearInterval(timer);
            resolve(true);
          } else if (elapsed >= timeoutMs) {
            clearInterval(timer);
            resolve(false);
          }
        }, interval);
      });
    },

    /**
     * Get an attribute value from the first element matching selector.
     * @param {string} selector
     * @param {string} attr
     * @returns {string|null}
     */
    getAttribute: function (selector, attr) {
      var el = querySelector(selector);
      return el ? el.getAttribute(attr) : null;
    },

    /**
     * Get computed CSS property of the first element matching selector.
     * @param {string} selector
     * @param {string} prop
     * @returns {string|null}
     */
    getComputedStyle: function (selector, prop) {
      var el = querySelector(selector);
      if (!el) return null;
      return window.getComputedStyle(el).getPropertyValue(prop);
    },

    /**
     * Get bounding rect of the first element matching selector.
     * @param {string} selector
     * @returns {DOMRect|null}
     */
    getBoundingRect: function (selector) {
      var el = querySelector(selector);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    },

    /**
     * Health check — always returns true once bridge is loaded.
     * @returns {boolean}
     */
    ready: function () {
      return true;
    },
  };

  console.log('[test-bridge] Rally test bridge injected');
})();
