import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StudioProvider, useStudio } from './studio/StudioContext'
import StudioDocumentPane from './studio/StudioDocumentPane'
import StudioGridPane from './studio/StudioGridPane'
import { clamp, findCell, getPages, getTablesForPage, updateAnnotationCell } from './studio/studioUtils'

const API = ''
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8

async function parseJsonResponse(response) {
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    const detail = data?.detail || `Request failed with status ${response.status}`
    throw new Error(detail)
  }

  return data || {}
}

function getToastPosition(clientX, clientY) {
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    return { x: clientX, y: clientY }
  }
  return { x: 160, y: 90 }
}

function cloneAnnotation(annotation) {
  return JSON.parse(JSON.stringify(annotation || {}))
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function StudioWorkspace({ job, onBack, onJobUpdate }) {
  const { state, dispatch } = useStudio()
  const [annotation, setAnnotation] = useState(() => cloneAnnotation(job.annotation))
  const [isEditingGridCell, setIsEditingGridCell] = useState(false)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const annotationRef = useRef(annotation)
  const workspaceRef = useRef(null)
  const pages = useMemo(() => getPages(annotation), [annotation])
  const pageCount = pages.length
  const activePageTables = useMemo(
    () => getTablesForPage(annotation, state.activePage),
    [annotation, state.activePage],
  )

  const showToast = useCallback((message, clientX, clientY) => {
    const position = getToastPosition(clientX, clientY)
    dispatch({
      type: 'showToast',
      toast: {
        message,
        x: position.x,
        y: position.y,
      },
    })
  }, [dispatch])

  useEffect(() => {
    annotationRef.current = annotation
  }, [annotation])

  useEffect(() => {
    const tableOnPage = activePageTables.find((table) => table.table_id === state.activeTable)
    if (!tableOnPage && activePageTables.length) {
      dispatch({ type: 'setActiveTable', tableId: activePageTables[0].table_id })
    }
    if (!activePageTables.length && state.activeTable !== null) {
      dispatch({ type: 'setActiveTable', tableId: null })
    }
  }, [activePageTables, dispatch, state.activeTable])

  useEffect(() => {
    if (!state.activeCell) {
      return
    }
    const current = findCell(annotation, state.activeCell)
    if (!current || (current.table.page || 0) !== state.activePage) {
      dispatch({ type: 'setActiveCell', cell: null })
    }
  }, [annotation, dispatch, state.activeCell, state.activePage])

  useEffect(() => {
    if (!state.toast) {
      return undefined
    }
    const timeout = window.setTimeout(() => {
      dispatch({ type: 'clearToast' })
    }, 1500)
    return () => window.clearTimeout(timeout)
  }, [dispatch, state.toast])

  const handleAnnotationUpdate = useCallback((nextAnnotation) => {
    annotationRef.current = nextAnnotation
    setAnnotation(nextAnnotation)
    onJobUpdate?.(job.id, { annotation: nextAnnotation })
  }, [job.id, onJobUpdate])

  const handleCopyText = useCallback(async (text, clientX, clientY) => {
    try {
      await copyTextToClipboard(text)
      showToast('Copied!', clientX, clientY)
    } catch (error) {
      console.error('Copy failed', error)
      dispatch({ type: 'incrementErrors' })
      showToast('Copy failed', clientX, clientY)
    }
  }, [dispatch, showToast])

  const commitCellEdit = useCallback(async (target, text, { historyMode }) => {
    const match = findCell(annotationRef.current, target)
    if (!match) {
      dispatch({ type: 'incrementErrors' })
      return false
    }

    const previousText = String(match.cell.text || '')
    const nextText = String(text || '')
    if (previousText === nextText) {
      return true
    }

    try {
      const response = await fetch(`${API}/api/results/${job.id}/cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: target.tableId,
          row: target.row,
          col: target.col,
          text: nextText,
        }),
      })

      if (!response.ok) {
        throw new Error(`Save failed with status ${response.status}`)
      }

      const nextAnnotation = updateAnnotationCell(annotationRef.current, target, nextText)
      handleAnnotationUpdate(nextAnnotation)
      dispatch({ type: 'setActiveTable', tableId: target.tableId })
      dispatch({ type: 'setActiveCell', cell: target })

      if (historyMode === 'record') {
        dispatch({
          type: 'recordEdit',
          edit: {
            ...target,
            previousText,
            nextText,
          },
        })
      }

      return true
    } catch (error) {
      console.error('Cell edit failed', error)
      dispatch({ type: 'incrementErrors' })
      return false
    }
  }, [dispatch, handleAnnotationUpdate, job.id])

  const handleUndo = useCallback(async () => {
    const edit = state.undoStack[state.undoStack.length - 1]
    if (!edit) {
      return
    }
    const didSave = await commitCellEdit(
      { tableId: edit.tableId, row: edit.row, col: edit.col },
      edit.previousText,
      { historyMode: 'undo' },
    )
    if (didSave) {
      dispatch({ type: 'completeUndo' })
    }
  }, [commitCellEdit, dispatch, state.undoStack])

  const handleRedo = useCallback(async () => {
    const edit = state.redoStack[state.redoStack.length - 1]
    if (!edit) {
      return
    }
    const didSave = await commitCellEdit(
      { tableId: edit.tableId, row: edit.row, col: edit.col },
      edit.nextText,
      { historyMode: 'redo' },
    )
    if (didSave) {
      dispatch({ type: 'completeRedo' })
    }
  }, [commitCellEdit, dispatch, state.redoStack])

  useEffect(() => {
    const handleKeyDown = (event) => {
      const modifier = event.metaKey || event.ctrlKey
      const tag = document.activeElement?.tagName
      const isEditable = document.activeElement?.isContentEditable || tag === 'TEXTAREA' || tag === 'INPUT'
      if (!modifier || isEditable || isEditingGridCell) {
        return
      }
      const key = event.key.toLowerCase()
      if (key !== 'z') {
        return
      }
      event.preventDefault()
      if (event.shiftKey) {
        void handleRedo()
      } else {
        void handleUndo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleRedo, handleUndo, isEditingGridCell])

  const handleMarqueeOCR = useCallback(async ({ bbox, clientX, clientY }) => {
    try {
      const response = await fetch(`${API}/api/process/${job.id}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_index: state.activePage,
          bbox: bbox,
        }),
      })
      const data = await parseJsonResponse(response)
      if (!data.ok) {
        throw new Error('OCR request failed')
      }

      const text = String(data.text || '').trim()
      if (!text) {
        showToast('No text detected in selection', clientX, clientY)
        return
      }

      if (state.activeCell) {
        const didSave = await commitCellEdit(state.activeCell, text, { historyMode: 'record' })
        if (didSave) {
          showToast('OCR text inserted into active cell', clientX, clientY)
        }
      } else {
        await copyTextToClipboard(text)
        showToast('OCR text copied to clipboard', clientX, clientY)
      }
    } catch (error) {
      console.error('Marquee OCR failed', error)
      dispatch({ type: 'incrementErrors' })
      showToast('Marquee OCR failed', clientX, clientY)
    } finally {
      dispatch({ type: 'setSelection', selection: null })
      dispatch({ type: 'setTool', tool: 'pointer' })
    }
  }, [
    job.id,
    state.activePage,
    state.activeCell,
    commitCellEdit,
    dispatch,
    showToast,
  ])

  const handleTableSelection = useCallback(async ({ bbox, clientX, clientY }) => {
    try {
      const response = await fetch(`${API}/api/process/${job.id}/tsr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_index: state.activePage,
          bbox: bbox,
        }),
      })
      const data = await parseJsonResponse(response)
      if (!data.ok) {
        throw new Error('TSR request failed')
      }

      if (data.annotation) {
        handleAnnotationUpdate(data.annotation)
      }

      const table = data.table
      if (table) {
        dispatch({ type: 'setActiveTable', tableId: table.table_id })
        dispatch({ type: 'setActivePage', page: table.page || state.activePage })
      }
      showToast('Table structure added', clientX, clientY)
    } catch (error) {
      console.error('TSR failed', error)
      dispatch({ type: 'incrementErrors' })
      showToast('Table structure extraction failed', clientX, clientY)
    } finally {
      dispatch({ type: 'setSelection', selection: null })
      dispatch({ type: 'setTool', tool: 'pointer' })
    }
  }, [
    job.id,
    state.activePage,
    dispatch,
    handleAnnotationUpdate,
    showToast,
  ])

  const handleMergeCells = useCallback(async ({ tableId, startRow, startCol, endRow, endCol }) => {
    try {
      const response = await fetch(`${API}/api/results/${job.id}/cells/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: tableId,
          start_row: startRow,
          start_col: startCol,
          end_row: endRow,
          end_col: endCol,
        }),
      })
      const data = await parseJsonResponse(response)
      if (!data.ok || !data.annotation) {
        throw new Error('Merge operation failed')
      }

      handleAnnotationUpdate(data.annotation)
      dispatch({ type: 'setCellSelection', selection: null })
      dispatch({ type: 'setActiveTable', tableId })
      if (data.merged_cell) {
        dispatch({
          type: 'setActiveCell',
          cell: {
            tableId,
            row: data.merged_cell.row,
            col: data.merged_cell.col,
          },
        })
      }
      showToast('Cells merged successfully')
      return true
    } catch (error) {
      console.error('Merge cells failed', error)
      dispatch({ type: 'incrementErrors' })
      showToast(error.message || 'Merge cells failed')
      return false
    }
  }, [dispatch, handleAnnotationUpdate, job.id, showToast])

  const handleUnmergeCell = useCallback(async ({ tableId, row, col }) => {
    try {
      const response = await fetch(`${API}/api/results/${job.id}/cells/unmerge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_id: tableId,
          row,
          col,
        }),
      })
      const data = await parseJsonResponse(response)
      if (!data.ok || !data.annotation) {
        throw new Error('Unmerge operation failed')
      }

      handleAnnotationUpdate(data.annotation)
      dispatch({ type: 'setCellSelection', selection: null })
      dispatch({ type: 'setActiveTable', tableId })
      dispatch({ type: 'setActiveCell', cell: { tableId, row, col } })
      showToast('Cell unmerged')
      return true
    } catch (error) {
      console.error('Unmerge cell failed', error)
      dispatch({ type: 'incrementErrors' })
      showToast(error.message || 'Unmerge failed')
      return false
    } finally {
      dispatch({ type: 'setSelection', selection: null })
    }
  }, [dispatch, handleAnnotationUpdate, job.id, showToast])

  const handleStartResize = useCallback((event) => {
    event.preventDefault()
    const workspace = workspaceRef.current
    if (!workspace) {
      return
    }

    const updateSplit = (clientX) => {
      const bounds = workspace.getBoundingClientRect()
      if (!bounds.width) {
        return
      }
      const ratio = (clientX - bounds.left) / bounds.width
      setSplitRatio(clamp(ratio, SPLIT_MIN, SPLIT_MAX))
    }

    updateSplit(event.clientX)
    const handleMove = (moveEvent) => {
      updateSplit(moveEvent.clientX)
    }

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
  }, [])

  const handleExport = useCallback((format) => {
    window.open(`${API}/api/export/${job.id}?format=${format}`, '_blank', 'noopener,noreferrer')
  }, [job.id])

  const secondsPerPage = pageCount ? Number(job.duration || 0) / pageCount : 0
  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="studio-header-brand">
          <button type="button" className="studio-brand-button" onClick={onBack}>
            Agent P-DF
          </button>
          <div className="studio-header-file">{job.filename}</div>
        </div>

        <div className="studio-header-pill">
          <span>Pages: {Math.min(state.activePage + 1, pageCount)}/{pageCount}</span>
          <span>Speed: {secondsPerPage.toFixed(1)} sec/page</span>
          <span>Errors: {state.errorCount}</span>
        </div>

        <div className="studio-header-actions">
          <button type="button" className="btn btn-primary btn-export" onClick={() => handleExport('csv')}>
            Export CSV
          </button>
          <button type="button" className="btn btn-primary btn-export" onClick={() => handleExport('xlsx')}>
            Export Excel
          </button>
          <button type="button" className="btn btn-primary btn-export" onClick={() => handleExport('html')}>
            Export HTML
          </button>
        </div>
      </header>

      <div className="studio-workspace" ref={workspaceRef}>
        <div className="studio-pane-wrap" style={{ flexBasis: `${splitRatio * 100}%` }}>
          <StudioDocumentPane
            annotation={annotation}
            jobId={job.id}
            onCopyText={handleCopyText}
            onSelectionEnd={(selectionPayload) => {
               if (state.activeTool === 'marquee') handleMarqueeOCR(selectionPayload)
               else handleTableSelection(selectionPayload)
             }}
          />
        </div>

        <div
          className="studio-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={Math.round(SPLIT_MIN * 100)}
          aria-valuemax={Math.round(SPLIT_MAX * 100)}
          aria-valuenow={Math.round(splitRatio * 100)}
          onPointerDown={handleStartResize}
          onDoubleClick={() => setSplitRatio(0.5)}
        />

        <div className="studio-pane-wrap studio-pane-wrap-right" style={{ flexBasis: `${(1 - splitRatio) * 100}%` }}>
          <StudioGridPane
            annotation={annotation}
            onEditCell={commitCellEdit}
            onEditingChange={setIsEditingGridCell}
            onMergeCells={handleMergeCells}
            onUnmergeCell={handleUnmergeCell}
          />
        </div>
      </div>

      {state.toast && (
        <div
          className="studio-toast"
          style={{
            left: state.toast.x,
            top: state.toast.y,
          }}
        >
          {state.toast.message}
        </div>
      )}
    </div>
  )
}

export default function ResultsView({ job, onBack, onJobUpdate }) {
  return (
    <StudioProvider key={job.id} annotation={job.annotation}>
      <StudioWorkspace job={job} onBack={onBack} onJobUpdate={onJobUpdate} />
    </StudioProvider>
  )
}
