// Renders one page of a PDF to a canvas with pdf.js. The document is loaded once per URL.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function usePdf(url: string | undefined) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!url) return;
    // disableFontFace: draw glyphs as paths. With browser FontFace loading, embedded Arabic
    // subset fonts rendered with broken glyph spacing in testing.
    const task = pdfjs.getDocument({ url, disableFontFace: true });
    task.promise.then(setDoc, () => setError('تعذّر فتح الملف في العارض.'));
    return () => void task.destroy();
  }, [url]);
  return { doc, error };
}

export function PdfPage({ doc, pageNo }: { doc: pdfjs.PDFDocumentProxy; pageNo: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Re-render on container resize.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!width || !canvas.current) return;
    let task: pdfjs.RenderTask | undefined;
    let cancelled = false;
    void doc.getPage(pageNo).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${Math.floor(viewport.width)}px`;
      c.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      task.promise.catch(() => {}); // cancelled renders reject
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNo, width]);

  return (
    <div ref={box} className="w-full">
      <canvas ref={canvas} className="rounded-lg border border-stone-200 bg-white shadow-sm" />
    </div>
  );
}
