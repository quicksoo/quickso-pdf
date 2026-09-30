import { PDFDocument } from 'pdf-lib'

type AnalyzeRequest = { type: 'analyze'; id: string; bytes: ArrayBuffer }
type MergeRequest = { type: 'merge'; id: string; files: ArrayBuffer[] }

type WorkerRequest = AnalyzeRequest | MergeRequest

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    if (request.type === 'analyze') {
      const pdf = await PDFDocument.load(request.bytes, { ignoreEncryption: true })
      self.postMessage({ type: 'analyze:done', id: request.id, pages: pdf.getPageCount() })
      return
    }

    if (request.type === 'merge') {
      const merged = await PDFDocument.create()
      let pages = 0
      for (const bytes of request.files) {
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
        const copied = await merged.copyPages(pdf, pdf.getPageIndices())
        copied.forEach((page) => merged.addPage(page))
        pages += copied.length
        self.postMessage({ type: 'merge:progress', id: request.id, pages })
      }
      const output = await merged.save()
      self.postMessage({ type: 'merge:done', id: request.id, bytes: output }, [output.buffer])
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : 'PDF 处理失败',
    })
  }
}
