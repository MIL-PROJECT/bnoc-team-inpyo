import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';

type RequestMessage = { type: 'load'; buffer: ArrayBuffer } | { type: 'render'; page: number };
type ResponseMessage = { type: 'ready'; pageCount: number } | { type: 'page'; page: number; svg: string } | { type: 'error' };
type RendererGlobal = typeof globalThis & {
  measureTextWidth?: (font: string, text: string) => number;
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage: (message: ResponseMessage) => void;
};

const scope = globalThis as RendererGlobal;
let document: HwpDocument | null = null;
let pageCount = 0;
let ready: Promise<unknown> | null = null;
let measureContext: OffscreenCanvasRenderingContext2D | null = null;

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      scope.measureTextWidth = (font, text) => {
        if (!measureContext) measureContext = new OffscreenCanvas(1, 1).getContext('2d');
        if (!measureContext) throw new Error('CanvasUnavailable');
        measureContext.font = font;
        return measureContext.measureText(text).width;
      };
      ready ??= init({ module_or_path: wasmUrl });
      await ready;
      document?.free();
      document = new HwpDocument(new Uint8Array(data.buffer));
      pageCount = document.pageCount();
      if (pageCount < 1 || pageCount > 300) throw new Error('PageLimit');
      scope.postMessage({ type: 'ready', pageCount });
      return;
    }
    if (!document || data.page < 0 || data.page >= pageCount) throw new Error('PageUnavailable');
    const svg = document.renderPageSvg(data.page);
    if (!svg.startsWith('<svg') || svg.length > 10 * 1024 * 1024) throw new Error('RenderLimit');
    scope.postMessage({ type: 'page', page: data.page, svg });
  } catch {
    scope.postMessage({ type: 'error' });
  }
};
