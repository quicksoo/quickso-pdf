<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { saveAs } from 'file-saver'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type PdfItem = {
  id: string
  file: File
  pages: number | null
  thumbnail: string | null
  progress: number
  status: 'queued' | 'parsing' | 'ready' | 'error'
  error?: string
}

type WorkerMessage =
  | { type: 'analyze:done'; id: string; pages: number }
  | { type: 'merge:progress'; id: string; pages: number }
  | { type: 'merge:done'; id: string; bytes: ArrayBuffer }
  | { type: 'error'; id: string; message: string }

const items = ref<PdfItem[]>([])
const isDragging = ref(false)
const isMerging = ref(false)
const dragIndex = ref<number | null>(null)
const outputName = ref('quickso-merged.pdf')
const statusText = ref('等待添加 PDF 文件')
const statusKind = ref<'normal' | 'success' | 'error'>('normal')
const fileInput = ref<HTMLInputElement | null>(null)
const showClearConfirm = ref(false)
const parseTotal = ref(0)
const parseCompleted = ref(0)
const parseStartedAt = ref<number | null>(null)
const parseNow = ref(Date.now())
let parseTimer: ReturnType<typeof setInterval> | null = null

const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' })
const pending = new Map<string, (message: WorkerMessage) => void>()

worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === 'merge:progress') {
    statusText.value = `正在合并 · 已处理 ${message.pages} 页`
    return
  }
  const resolve = pending.get(message.id)
  if (resolve) {
    pending.delete(message.id)
    resolve(message)
  }
}

const totalPages = computed(() => items.value.reduce((sum, item) => sum + (Number(item.pages) || 0), 0))
const totalBytes = computed(() => items.value.reduce((sum, item) => sum + item.file.size, 0))
const readyCount = computed(() => items.value.filter((item) => item.status === 'ready').length)
const failedCount = computed(() => items.value.filter((item) => item.status === 'error').length)
const resolvedCount = computed(() => readyCount.value + failedCount.value)
const isParsing = computed(() => items.value.some((item) => item.status === 'queued' || item.status === 'parsing'))
const allReady = computed(() => items.value.length > 0 && readyCount.value === items.value.length)
const parseActive = computed(() => parseTotal.value > 0 && parseCompleted.value < parseTotal.value)
const effectiveStatusText = computed(() => {
  if (!items.value.length || statusKind.value === 'error' || statusKind.value === 'success' || isMerging.value) return statusText.value
  if (isParsing.value) return `正在解析 ${resolvedCount.value}/${items.value.length} 个文件 · ${parseEta.value}`
  if (failedCount.value) return `已解析 ${readyCount.value} 个文件，${failedCount.value} 个文件失败`
  return `已准备 ${readyCount.value} 个文件，可开始合并`
})
const parseEta = computed(() => {
  if (!parseActive.value && parseTotal.value > 0 && parseCompleted.value >= parseTotal.value) return '解析完成'
  if (!parseStartedAt.value || parseCompleted.value === 0) return '预计计算中'
  const elapsed = (parseNow.value - parseStartedAt.value) / 1000
  const remaining = Math.max(0, Math.ceil((elapsed / parseCompleted.value) * (parseTotal.value - parseCompleted.value)))
  return remaining < 1 ? '即将完成' : `预计还需 ${formatDuration(remaining)}`
})

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
}

function timestamp() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function defaultOutputName(fileName: string) {
  const baseName = (fileName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '-').trim() || 'quickso-merged')
  return `${baseName}-${timestamp()}.pdf`
}

function normalizeName(name: string) {
  const trimmed = name.trim() || 'quickso-merged'
  return trimmed.toLowerCase().endsWith('.pdf') ? trimmed : `${trimmed}.pdf`
}

function analyze(item: PdfItem) {
  // The item pushed into the reactive array is a proxy; always mutate that proxy
  // so computed statistics are invalidated together with the row UI.
  const target = items.value.find((entry) => entry.id === item.id) ?? item
  target.status = 'parsing'
  target.progress = 18
  const id = uid()
  return new Promise<void>((resolve) => {
    pending.set(id, (message) => {
      if (message.type === 'analyze:done') {
        target.pages = message.pages
        target.status = 'ready'
        target.progress = 100
        void renderThumbnail(target)
      } else if (message.type === 'error') {
        target.status = 'error'
        target.progress = 0
        target.error = '无法读取该 PDF'
      }
      resolve()
    })
    target.file.arrayBuffer().then((bytes) => {
      target.progress = 42
      worker.postMessage({ type: 'analyze', id, bytes }, [bytes])
    }).catch(() => {
      target.status = 'error'
      target.progress = 0
      target.error = '无法读取该 PDF'
      resolve()
    })
  })
}

async function renderThumbnail(item: PdfItem) {
  try {
    const bytes = await item.file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
    const page = await pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = 160 / base.width
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
    item.thumbnail = canvas.toDataURL('image/jpeg', 0.82)
    await pdf.destroy()
  } catch {
    item.thumbnail = null
  }
}

async function addFiles(fileList: FileList | File[]) {
  const files = Array.from(fileList).filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))
  if (!files.length) {
    statusText.value = '请选择 PDF 文件'
    statusKind.value = 'error'
    return
  }
  statusKind.value = 'normal'
  const isFirstBatch = items.value.length === 0
  if (isFirstBatch) outputName.value = defaultOutputName(files[0].name)
  const additions = files.map<PdfItem>((file) => ({ id: uid(), file, pages: null, thumbnail: null, progress: 0, status: 'queued' }))
  items.value.push(...additions)
  parseTotal.value = items.value.length
  parseCompleted.value = items.value.filter((item) => item.status === 'ready' || item.status === 'error').length
  parseStartedAt.value = Date.now()
  parseNow.value = Date.now()
  if (parseTimer) clearInterval(parseTimer)
  parseTimer = setInterval(() => { parseNow.value = Date.now() }, 250)
  statusText.value = `正在解析 ${parseCompleted.value}/${parseTotal.value} 个文件 · ${parseEta.value}`
  await Promise.all(additions.map(async (item) => {
    await analyze(item)
    parseCompleted.value += 1
    statusText.value = `正在解析 ${parseCompleted.value}/${parseTotal.value} 个文件 · ${parseEta.value}`
  }))
  if (parseTimer) clearInterval(parseTimer)
  parseTimer = null
  parseNow.value = Date.now()
  statusText.value = `已准备 ${readyCount.value} 个文件，可开始合并`
}

function onInput(event: Event) {
  const target = event.target as HTMLInputElement
  if (target.files) void addFiles(target.files)
  target.value = ''
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  if (event.dataTransfer?.files) void addFiles(event.dataTransfer.files)
}

function move(index: number, direction: -1 | 1) {
  const next = index + direction
  if (next < 0 || next >= items.value.length) return
  const [item] = items.value.splice(index, 1)
  items.value.splice(next, 0, item)
}

function onDragStart(index: number) { dragIndex.value = index }
function onDragOver(index: number) {
  if (dragIndex.value === null || dragIndex.value === index) return
  const [item] = items.value.splice(dragIndex.value, 1)
  items.value.splice(index, 0, item)
  dragIndex.value = index
}
function onDragEnd() { dragIndex.value = null }

function removeItem(index: number) {
  items.value.splice(index, 1)
  statusKind.value = 'normal'
  statusText.value = items.value.length ? `${readyCount.value} 个文件已就绪` : '等待添加 PDF 文件'
}

function clearAll() {
  items.value = []
  outputName.value = 'quickso-merged.pdf'
  parseTotal.value = 0
  parseCompleted.value = 0
  parseStartedAt.value = null
  if (parseTimer) clearInterval(parseTimer)
  parseTimer = null
  statusKind.value = 'normal'
  statusText.value = '等待添加 PDF 文件'
}

function requestClearAll() {
  showClearConfirm.value = true
}

function cancelClearAll() {
  showClearConfirm.value = false
}

function confirmClearAll() {
  showClearConfirm.value = false
  clearAll()
}

function requestMerge() {
  if (!allReady.value || isMerging.value) return
  isMerging.value = true
  statusKind.value = 'normal'
  statusText.value = '正在准备合并…'
  const id = uid()
  pending.set(id, (message) => {
    isMerging.value = false
    if (message.type === 'merge:done') {
      saveAs(new Blob([message.bytes], { type: 'application/pdf' }), normalizeName(outputName.value))
      statusText.value = `合并完成 · ${totalPages.value} 页已下载`
      statusKind.value = 'success'
    } else if (message.type === 'error') {
      statusText.value = message.message || '合并失败，请检查文件'
      statusKind.value = 'error'
    }
  })
  Promise.all(items.value.map((item) => item.file.arrayBuffer())).then((files) => worker.postMessage({ type: 'merge', id, files }, files))
}

onBeforeUnmount(() => {
  if (parseTimer) clearInterval(parseTimer)
  worker.terminate()
})
</script>

<template>
  <div class="app-shell">
    <header class="container nav">
      <div class="brand"><div class="brand-mark"><span>QS</span></div><span>QuickSo PDF</span></div>
      <div class="nav-note">简洁 · 私密 · 浏览器本地处理</div>
    </header>

    <main class="container workspace">
      <section class="hero">
        <div class="eyebrow"><span class="eyebrow-dot" /> PDF WORKSPACE</div>
        <h1>把 PDF 合在一起，<br /><span style="color:#0f766e">就这么简单。</span></h1>
        <p class="hero-copy">无需上传服务器。拖入文件，调整顺序，点击合并。所有处理都在你的浏览器内完成。</p>
      </section>

      <section class="panel" style="padding: 14px">
        <div class="dropzone" :class="{ active: isDragging }" @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false" @drop.prevent="onDrop">
          <h2>拖放 PDF 到这里</h2>
          <p>支持多个文件 · 单个文件最大建议 100 MB</p>
          <button class="primary-btn" type="button" @click="fileInput?.click()"><span>＋</span> 选择 PDF 文件</button>
          <input ref="fileInput" hidden type="file" accept="application/pdf,.pdf" multiple @change="onInput" />
        </div>
      </section>

      <section class="stats">
        <div class="stat"><div class="stat-label">文件数</div><div class="stat-value">{{ items.length }}</div></div>
        <div class="stat"><div class="stat-label">总页数</div><div class="stat-value">{{ totalPages }}</div></div>
        <div class="stat"><div class="stat-label">源文件大小</div><div class="stat-value">{{ formatBytes(totalBytes) }}</div></div>
        <div class="stat"><div class="stat-label">解析状态</div><div class="stat-value small">{{ !items.length ? '等待文件' : isParsing ? '处理中' : failedCount ? `${failedCount} 个失败` : '全部就绪' }}</div></div>
      </section>

      <section class="panel files-panel">
        <div class="panel-head"><div><div class="panel-title">合并顺序</div><div class="panel-meta">拖动行项目可调整顺序</div></div><button v-if="items.length" class="subtle-btn" type="button" @click="requestClearAll">清空全部</button></div>
        <div v-if="items.length" class="file-list">
          <div v-for="(item, index) in items" :key="item.id" class="file-row" :class="{ dragging: dragIndex === index }" draggable="true" @dragstart="onDragStart(index)" @dragover.prevent="onDragOver(index)" @dragend="onDragEnd">
            <div class="thumb"><img v-if="item.thumbnail" :src="item.thumbnail" :alt="item.file.name" /><span v-else>PDF</span></div>
            <div style="min-width:0"><div class="file-name" :title="item.file.name">{{ item.file.name }}</div><div class="file-meta"><span>{{ formatBytes(item.file.size) }}</span><span>{{ item.pages === null ? '解析中…' : `${item.pages} 页` }}</span><span v-if="item.status === 'ready'" class="file-ready">✓ 已解析</span><span v-if="item.status === 'error'" style="color:#dc5548">读取失败</span></div><div v-if="item.status !== 'ready'" class="item-progress"><div class="item-progress-track"><div class="item-progress-fill" :class="{ error: item.status === 'error' }" :style="{ width: `${item.progress}%` }" /></div><span>{{ item.status === 'error' ? '解析失败' : `${item.progress}%` }}</span></div></div>
            <div class="file-actions"><button class="icon-btn" type="button" title="上移" :disabled="index === 0" @click="move(index, -1)">↑</button><button class="icon-btn" type="button" title="下移" :disabled="index === items.length - 1" @click="move(index, 1)">↓</button><button class="icon-btn remove-btn" type="button" title="移除" @click="removeItem(index)">×</button></div>
          </div>
        </div>
        <div v-else class="empty-state">添加文件后会显示在这里，你可以自由调整合并顺序。</div>
      </section>

      <section class="panel action-bar">
        <div class="output-field"><label for="output-name">输出文件名</label><input id="output-name" v-model="outputName" class="output-input" spellcheck="false" /></div>
        <button class="primary-btn" type="button" :disabled="!allReady || isMerging" @click="requestMerge"><span>⇩</span>{{ isMerging ? '正在合并…' : '合并并下载' }}</button>
      </section>
      <div class="status" :class="statusKind">{{ effectiveStatusText }}</div>
    </main>

    <footer class="container footer"><span><strong>QuickSo PDF</strong> · 你的文件始终留在你的设备上</span><span class="privacy">◉ 本地处理，不上传</span></footer>

    <div v-if="showClearConfirm" class="modal-backdrop" role="presentation" @click.self="cancelClearAll">
      <section class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="clear-dialog-title">
        <div class="confirm-icon">!</div>
        <h2 id="clear-dialog-title">清空所有文件？</h2>
        <p>当前列表中的 {{ items.length }} 个 PDF 将被移除，此操作无法撤销。</p>
        <div class="confirm-actions"><button class="subtle-btn" type="button" @click="cancelClearAll">取消</button><button class="danger-btn" type="button" @click="confirmClearAll">确认清空</button></div>
      </section>
    </div>
  </div>
</template>
