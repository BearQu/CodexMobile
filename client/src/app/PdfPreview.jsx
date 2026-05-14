import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

const workerUrl = new URL(pdfWorkerUrl, window.location.href);
workerUrl.searchParams.set('codexmobileWorkerMime', '2');
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;

export function PdfPreview({ data, fileUrl = '' }) {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const renderTaskRef = useRef(null);
  const renderRequestRef = useRef(0);
  const [doc, setDoc] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState('width');
  const [canFitPage, setCanFitPage] = useState(false);
  const [error, setError] = useState('');

  const source = useMemo(() => {
    if (data) {
      return { data: new Uint8Array(data.slice(0)) };
    }
    return fileUrl ? { url: fileUrl } : null;
  }, [data, fileUrl]);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPageCount(0);
    setPageNumber(1);
    setError('');
    if (!source) {
      return undefined;
    }
    const loadingTask = pdfjs.getDocument(source);
    loadingTask.promise
      .then((pdf) => {
        if (!cancelled) {
          setDoc(pdf);
          setPageCount(pdf.numPages);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError?.message || 'PDF 加载失败');
        }
      });
    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [source]);

  useEffect(() => {
    if (!doc || !canvasRef.current || !stageRef.current) {
      return undefined;
    }
    let cancelled = false;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const context = canvas.getContext('2d');

    async function render(requestId) {
      let task = null;
      try {
        const previousTask = renderTaskRef.current;
        if (previousTask) {
          previousTask.cancel();
          try {
            await previousTask.promise;
          } catch {
            // PDF.js rejects cancelled render tasks; the rejection only means the canvas is free.
          }
          if (renderTaskRef.current === previousTask) {
            renderTaskRef.current = null;
          }
        }
        if (cancelled || requestId !== renderRequestRef.current) {
          return;
        }
        const page = await doc.getPage(pageNumber);
        if (cancelled || requestId !== renderRequestRef.current) {
          return;
        }
        const baseViewport = page.getViewport({ scale: 1 });
        const horizontalPadding = 28;
        const verticalPadding = 28;
        const fitWidthScale = Math.max(0.2, (stage.clientWidth - horizontalPadding) / baseViewport.width);
        const fitPageScale = Math.max(
          0.2,
          Math.min(fitWidthScale, (stage.clientHeight - verticalPadding) / baseViewport.height)
        );
        const pageFitIsUseful = fitPageScale < fitWidthScale - 0.01;
        setCanFitPage((value) => (value === pageFitIsUseful ? value : pageFitIsUseful));
        const baseScale = fitMode === 'page' && pageFitIsUseful ? fitPageScale : fitWidthScale;
        const renderScale = Math.max(0.2, Math.min(4, baseScale * zoom));
        const viewport = page.getViewport({ scale: renderScale });
        const pixelRatio = Math.min(3, window.devicePixelRatio || 1);
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        task = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (renderError) {
        if (!cancelled && requestId === renderRequestRef.current && renderError?.name !== 'RenderingCancelledException') {
          setError(renderError?.message || 'PDF 渲染失败');
        }
      } finally {
        if (task && renderTaskRef.current === task) {
          renderTaskRef.current = null;
        }
      }
    }

    let frame = 0;
    const scheduleRender = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const requestId = renderRequestRef.current + 1;
        renderRequestRef.current = requestId;
        render(requestId);
      });
    };

    scheduleRender();
    const observer = new ResizeObserver(scheduleRender);
    observer.observe(stage);
    return () => {
      cancelled = true;
      renderRequestRef.current += 1;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      renderTaskRef.current?.cancel?.();
    };
  }, [doc, pageNumber, fitMode, zoom]);

  if (error) {
    return <div className="file-preview-error"><strong>{error}</strong></div>;
  }

  return (
    <div className="pdf-preview">
      <div className="pdf-preview-controls" aria-label="PDF 工具">
        <div className="pdf-preview-control-group pdf-preview-page-group">
          <button type="button" aria-label="上一页" onClick={() => setPageNumber((value) => Math.max(1, value - 1))} disabled={pageNumber <= 1}>
            <ChevronLeft size={16} />
          </button>
          <span className="pdf-preview-page-count">{pageCount ? `${pageNumber} / ${pageCount}` : '加载中'}</span>
          <button type="button" aria-label="下一页" onClick={() => setPageNumber((value) => Math.min(pageCount || value, value + 1))} disabled={!pageCount || pageNumber >= pageCount}>
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="pdf-preview-control-group" aria-label="缩放">
          <button type="button" aria-label="缩小 PDF" onClick={() => setZoom((value) => Math.max(0.5, value - 0.15))}>
            <Minus size={16} />
          </button>
          <button type="button" aria-label="放大 PDF" onClick={() => setZoom((value) => Math.min(3, value + 0.15))}>
            <Plus size={16} />
          </button>
        </div>
        <div className="pdf-preview-control-group pdf-preview-fit-group">
          <button type="button" className={fitMode === 'width' || !canFitPage ? 'is-active' : ''} onClick={() => { setFitMode('width'); setZoom(1); }}>
            适宽
          </button>
          {canFitPage ? (
            <button type="button" className={fitMode === 'page' ? 'is-active' : ''} onClick={() => { setFitMode('page'); setZoom(1); }}>
              <Maximize2 size={15} />
              <span>整页</span>
            </button>
          ) : null}
        </div>
        {fileUrl ? (
          <a className="pdf-preview-open-original" href={fileUrl} target="_blank" rel="noreferrer noopener" aria-label="打开原文件">
            <ExternalLink size={16} />
          </a>
        ) : null}
      </div>
      <div className="pdf-preview-stage" ref={stageRef}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
