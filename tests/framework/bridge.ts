/**
 * WebView test bridge client — communicates with Rally via HTTP.
 *
 * Sends commands to the Rust test server on localhost:9876, which
 * proxies them to the Tauri WebView via eval().
 */

const BASE_URL = "http://127.0.0.1:9876";

export class Bridge {
  /**
   * Evaluate arbitrary JavaScript in the WebView.
   * Returns the result of the expression.
   */
  async eval<T = unknown>(js: string): Promise<T> {
    const res = await fetch(`${BASE_URL}/eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ js }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Bridge eval failed: ${err.error}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`JS error: ${data.error}`);
    }
    return data.result as T;
  }

  /**
   * Invoke a Tauri command via the WebView's __TAURI__.core.invoke().
   */
  async invoke<T = unknown>(
    command: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    const res = await fetch(`${BASE_URL}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, args }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Bridge invoke failed: ${err.error}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`Invoke error: ${data.error}`);
    }
    return data.result as T;
  }

  /**
   * Check if the app is ready via the health endpoint.
   */
  async isReady(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (!res.ok) return false;
      const data = await res.json();
      return data.ready === true;
    } catch {
      return false;
    }
  }

  // --- Bridge convenience methods (call window.__rallyTest.*) ---

  /** Click an element by CSS selector. */
  async click(selector: string): Promise<boolean> {
    return this.eval<boolean>(
      `return window.__rallyTest.click(${JSON.stringify(selector)})`
    );
  }

  /** Type text into an input by CSS selector. */
  async type(selector: string, text: string): Promise<boolean> {
    return this.eval<boolean>(
      `return window.__rallyTest.type(${JSON.stringify(selector)}, ${JSON.stringify(text)})`
    );
  }

  /** Get the Zustand store state snapshot. */
  async getStoreState(): Promise<Record<string, unknown> | null> {
    return this.eval<Record<string, unknown> | null>(
      "return window.__rallyTest.getStoreState()"
    );
  }

  /** Get text content of the first matching element. */
  async getElementText(selector: string): Promise<string | null> {
    return this.eval<string | null>(
      `return window.__rallyTest.getElementText(${JSON.stringify(selector)})`
    );
  }

  /** Count elements matching a selector. */
  async getElementCount(selector: string): Promise<number> {
    return this.eval<number>(
      `return window.__rallyTest.getElementCount(${JSON.stringify(selector)})`
    );
  }

  /** Check if an element is visible. */
  async isVisible(selector: string): Promise<boolean> {
    return this.eval<boolean>(
      `return window.__rallyTest.isVisible(${JSON.stringify(selector)})`
    );
  }

  /** Wait for a selector to appear in the DOM. */
  async waitForSelector(
    selector: string,
    timeoutMs = 5000
  ): Promise<boolean> {
    return this.eval<boolean>(
      `return window.__rallyTest.waitForSelector(${JSON.stringify(selector)}, ${timeoutMs})`
    );
  }

  /** Wait for a store property to match a value. */
  async waitForStoreCondition(
    path: string,
    value: unknown,
    timeoutMs = 5000
  ): Promise<boolean> {
    return this.eval<boolean>(
      `return window.__rallyTest.waitForStoreCondition(${JSON.stringify(path)}, ${JSON.stringify(value)}, ${timeoutMs})`
    );
  }

  /** Get a computed CSS property of an element. */
  async getComputedStyle(
    selector: string,
    prop: string
  ): Promise<string | null> {
    return this.eval<string | null>(
      `return window.__rallyTest.getComputedStyle(${JSON.stringify(selector)}, ${JSON.stringify(prop)})`
    );
  }

  /** Get the bounding rect of an element. */
  async getBoundingRect(
    selector: string
  ): Promise<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null> {
    return this.eval(
      `return window.__rallyTest.getBoundingRect(${JSON.stringify(selector)})`
    );
  }
}

export const bridge = new Bridge();
