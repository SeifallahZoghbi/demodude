// The slice of Playwright's API that check.ts uses, so the starter kit type-checks without the
// package installed. In the app, `playwright` is a real devDependency whose own types win over this
// ambient declaration — delete this file there to avoid any doubt.
declare module "playwright" {
  export interface ConsoleMessage {
    type(): string;
    text(): string;
  }
  export interface Request {
    url(): string;
  }
  export interface Download {
    cancel(): Promise<void>;
  }
  export interface JSHandle<T = unknown> {
    jsonValue(): Promise<T>;
  }
  export interface Page {
    on(event: "pageerror", listener: (error: Error) => void): this;
    on(event: "console", listener: (message: ConsoleMessage) => void): this;
    on(event: "request", listener: (request: Request) => void): this;
    on(event: "popup", listener: (page: Page) => void): this;
    on(event: "download", listener: (download: Download) => void): this;
    goto(url: string): Promise<unknown>;
    close(): Promise<void>;
    evaluate<R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
    evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
    waitForFunction<R, Arg>(fn: (arg: Arg) => R, arg: Arg, options?: { timeout?: number }): Promise<JSHandle<R>>;
    screenshot(options?: { path?: string; fullPage?: boolean }): Promise<unknown>;
  }
  export interface BrowserContext {
    newPage(): Promise<Page>;
  }
  export interface Browser {
    newContext(options?: { viewport?: { width: number; height: number }; acceptDownloads?: boolean }): Promise<BrowserContext>;
    close(): Promise<void>;
  }
  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}
