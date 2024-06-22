import { Event, HandlerDetails, WebContentsView, session } from "electron";
import { inject, injectable } from "inversify";
import { TYPES } from "../types.ts";
import isDev from "electron-is-dev";
import {
  PERSIST_WEBVIEW,
  fetch,
  mobileUA,
  pcUA,
  pluginPath,
} from "../helper/index.ts";
import { ElectronBlocker } from "@cliqz/adblocker-electron";
import ElectronLogger from "../vendor/ElectronLogger.ts";
import ElectronStore from "../vendor/ElectronStore.ts";
import MainWindow from "../windows/MainWindow.ts";
import BrowserWindow from "../windows/BrowserWindow.ts";
import VideoRepository from "../repository/VideoRepository.ts";
import { SniffingHelper, SourceParams } from "./SniffingHelperService.ts";
import { resolve } from "path";
import { readFileSync } from "fs-extra";
import { nativeTheme } from "electron/main";

@injectable()
export default class WebviewService {
  private view: WebContentsView | null = null;
  private blocker?: ElectronBlocker;

  constructor(
    @inject(TYPES.MainWindow)
    private readonly mainWindow: MainWindow,
    @inject(TYPES.ElectronLogger)
    private readonly logger: ElectronLogger,
    @inject(TYPES.BrowserWindow)
    private readonly browserWindow: BrowserWindow,
    @inject(TYPES.ElectronStore)
    private readonly store: ElectronStore,
    @inject(TYPES.VideoRepository)
    private readonly videoRepository: VideoRepository,
    @inject(TYPES.SniffingHelper)
    private readonly sniffingHelper: SniffingHelper
  ) {
    // 初始化 blocker
    this.initBlocker();

    this.sniffingHelper.start();
    this.sniffingHelper.on("source", this.onSource);

    const { useProxy, proxy } = this.store.store;
    this.setProxy(useProxy, proxy);
  }

  async init(): Promise<void> {
    this.view = new WebContentsView({
      webPreferences: {
        partition: PERSIST_WEBVIEW,
        preload: resolve(__dirname, "./preload.js"),
      },
    });
    const background = nativeTheme.shouldUseDarkColors ? "#141414" : "#fff";
    this.view.setBackgroundColor(background);
    this.view.webContents.setAudioMuted(true);

    const { isMobile } = this.store.store;
    this.setUserAgent(isMobile);

    this.view.webContents.on("did-navigate", this.onDidNavigate);
    this.view.webContents.on("did-fail-load", this.onDidFailLoad);
    this.view.webContents.setWindowOpenHandler(this.onOpenNewWindow);
  }

  onDidNavigate = async () => {
    if (!this.view) return;
    const baseInfo = {
      title: this.view.webContents.getTitle(),
      url: this.view.webContents.getURL(),
    };
    this.sniffingHelper.reset(baseInfo);
    this.window.webContents.send("webview-did-navigate", baseInfo);

    try {
      if (isDev && process.env.DEBUG_PLUGINS === "true") {
        const content =
          'function addScript(src){const script=document.createElement("script");script.src=src;script.type="module";document.body.appendChild(script)}addScript("http://localhost:8080/src/main.ts");';
        await this.view.webContents.executeJavaScript(content);
      } else {
        const content = readFileSync(pluginPath, "utf-8");
        await this.view.webContents.executeJavaScript(content);
      }
    } catch (err) {
      // empty
    }
  };

  onDidFailLoad = (e: Event, code: number, desc: string) => {
    this.window.webContents.send("webview-fail-load", { code, desc });
  };

  onOpenNewWindow = ({ url }: HandlerDetails) => {
    this.loadURL(url);

    return { action: "deny" } as { action: "deny" };
  };

  onSource = async (item: SourceParams) => {
    if (!this.view) return;
    // 这里需要判断是否使用浏览器插件
    const useExtension = this.store.get("useExtension");
    if (useExtension) {
      this.view.webContents.send("webview-link-message", item);
    } else {
      const video = await this.videoRepository.findVideoByName(item.name);
      if (video) {
        item.name = `${item.name}-${Date.now()}`;
      }
      const res = await this.videoRepository.addVideo(item);
      const mainWebContents = this.mainWindow.window?.webContents;
      if (!mainWebContents) return;
      // 这里向页面发送消息，通知页面更新
      mainWebContents.send("download-item-notifier", res);
    }
  };

  getBounds(): Electron.Rectangle {
    if (!this.view) {
      throw new Error("未找到 view");
    }
    return this.view.getBounds();
  }

  setBounds(bounds: Electron.Rectangle): void {
    if (!this.view) return;
    this.view.setBounds(bounds);
  }

  setBackgroundColor(color: string): void {
    if (!this.view) return;
    this.view.setBackgroundColor(color);
  }

  show() {
    if (!this.view) return;
    this.window.contentView.addChildView(this.view);
  }

  hide() {
    if (!this.view) return;
    this.window.contentView.removeChildView(this.view);
  }

  loadURL(url: string) {
    // 开始加载 url
    if (!this.view) {
      this.init();
    }
    if (!this.view) return;

    // 1. 停止当前导航
    this.view.webContents.stop();

    // 2. 加载新的 url
    this.view.webContents.loadURL(url);
  }

  async goBack() {
    if (!this.view) {
      throw new Error("未找到 view");
    }
    const { webContents } = this.view;
    if (webContents.canGoBack()) {
      webContents.goBack();
      return true;
    } else {
      this.destroyView();
      return false;
    }
  }

  async reload() {
    if (!this.view) {
      throw new Error("未找到 view");
    }
    this.view.webContents.reload();
  }

  async goHome() {
    if (!this.view) {
      throw new Error("未找到 view");
    }
    this.view.webContents.stop();
    this.view.webContents.clearHistory();
    this.destroyView();
  }

  get window() {
    if (this.browserWindow.window) return this.browserWindow.window;
    if (this.mainWindow.window) return this.mainWindow.window;
    throw new Error("未找到当前窗口");
  }

  private get session() {
    return session.fromPartition(PERSIST_WEBVIEW);
  }

  private enableProxy(proxy: string) {
    if (!proxy) {
      this.logger.error("[proxy] 代理地址不能为空");
      return;
    }

    // 处理 proxy 地址的合法性
    if (!/https?:\/\//.test(proxy)) {
      proxy = `http://${proxy}`;
    }

    this.session.setProxy({ proxyRules: proxy });
    this.logger.info(`[proxy] 代理开启成功，代理地址为${proxy}`);
  }

  private disableProxy() {
    this.session.setProxy({ proxyRules: "" });
    this.logger.info("[proxy] 代理关闭成功");
  }

  setProxy(useProxy: boolean, proxy: string): void {
    if (useProxy) {
      this.enableProxy(proxy);
    } else {
      this.disableProxy();
    }
  }

  setBlocking(enableBlocking: boolean): void {
    if (enableBlocking) {
      this.enableBlocking();
    } else {
      this.disableBlocking();
    }
  }

  async initBlocker() {
    this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);

    const enableBlocking = this.store.get("blockAds");
    this.setBlocking(enableBlocking);
  }

  private enableBlocking() {
    if (!this.blocker) {
      this.logger.error("开启 blocker 失败，未初始化");
      return;
    }
    this.blocker.enableBlockingInSession(this.session);
    this.logger.info("开启 blocker 成功");
  }

  private disableBlocking() {
    if (!this.blocker) {
      this.logger.error("关闭 blocker 失败，未初始化");
      return;
    }
    if (!this.blocker.isBlockingEnabled(this.session)) {
      return;
    }
    this.blocker.disableBlockingInSession(this.session);
    this.logger.info("关闭 blocker 成功");
  }

  setUserAgent(isMobile?: boolean) {
    if (!this.view) return;
    if (isMobile) {
      this.view.webContents.setUserAgent(mobileUA);
    } else {
      this.view.webContents.setUserAgent(pcUA);
    }
    this.logger.info("设置 user-agent 成功", isMobile);
  }

  captureView(): Promise<Electron.NativeImage> {
    if (!this.view) {
      throw new Error("未找到 view");
    }
    return this.view.webContents.capturePage();
  }

  sendToWindow(channel: string, ...args: unknown[]) {
    this.window.webContents.send(channel, ...args);
  }

  destroyView() {
    if (this.view && this.window) {
      this.view.webContents.close();
      this.window.contentView.removeChildView(this.view);
    }
    // FIXME: 为了避免内存泄漏，这里需要销毁 view
    this.view = null;
  }
}
