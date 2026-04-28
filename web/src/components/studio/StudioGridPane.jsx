import { useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from './StudioContext'
import {
  buildTableModel,
  cleanCellText,
  findAdjacentCell,
  getCellKey,
  getTablesForPage,
  heatmapColor,
  isSameCell,
} from './studioUtils'

function scoreLabel(score) {
  if (score === null || score === undefined) {
    return 'No score'
  }
  return `${Math.round(score * 100)}%`
}

export default function StudioGridPane({
  annotation,
  onEditCell,
  onEditingChange,
  onMergeCells,
  onUnmergeCell,
}) {
  const { state, dispatch } = useStudio()
  const [editingCell, setEditingCell] = useState(null)
  const [draft, setDraft] = useState('')
  const [selectionAnchor, setSelectionAnchor] = useState(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const cellRefs = useRef(new Map())

  const activePageTables = useMemo(
    () => getTablesForPage(annotation, state.activePage),
    [annotation, state.activePage],
  )

  const contextTable = activePageTables.find((table) => table.table_id === state.activeTable) || activePageTables[0] || null

  const normalizedSelection = useMemo(() => {
    const raw = state.cellSelection
    if (!raw || raw.tableId !== contextTable?.table_id) {
      return null
    }
    const startRow = Math.min(raw.startRow, raw.endRow)
    const endRow = Math.max(raw.startRow, raw.endRow)
    const startCol = Math.min(raw.startCol, raw.endCol)
    const endCol = Math.max(raw.startCol, raw.endCol)
    return {
      tableId: raw.tableId,
      startRow,
      endRow,
      startCol,
      endCol,
      rowCount: endRow - startRow + 1,
      colCount: endCol - startCol + 1,
    }
  }, [contextTable?.table_id, state.cellSelection])

  const selectedCellCount = normalizedSelection
    ? normalizedSelection.rowCount * normalizedSelection.colCount
    : 0

  const canMergeSelection = Boolean(normalizedSelection && selectedCellCount > 1)
  const canUnmergeSelection = Boolean(normalizedSelection && selectedCellCount === 1)

  const selectionAnchorCell = useMemo(() => {
    if (!canUnmergeSelection || !contextTable) {
      return null
    }
    return (contextTable.cells || []).find((cell) => (
      cell.row === normalizedSelection.startRow && cell.col === normalizedSelection.startCol
    )) || null
  }, [canUnmergeSelection, contextTable, normalizedSelection])

  const canUnmergeAnchor = Boolean(
    selectionAnchorCell
    && ((selectionAnchorCell.row_span || 1) > 1 || (selectionAnchorCell.col_span || 1) > 1)
  )

  useEffect(() => {
    onEditingChange?.(Boolean(editingCell))
  }, [editingCell, onEditingChange])

  useEffect(() => {
    if (!isSelecting) {
      return undefined
    }

    const handleMouseUp = () => {
      setIsSelecting(false)
      setSelectionAnchor(null)
    }

    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [isSelecting])

  const focusCell = (target) => {
    const key = getCellKey(target.tableId, target.row, target.col)
    const node = cellRefs.current.get(key)
    node?.focus()
  }

  const handleCellFocus = (target) => {
    dispatch({ type: 'setActiveTable', tableId: target.tableId })
    dispatch({ type: 'setActiveCell', cell: target })
  }

  const setSelectionRange = (start, end) => {
    if (!start || !end || start.tableId !== end.tableId) {
      return
    }
    dispatch({
      type: 'setCellSelection',
      selection: {
        tableId: start.tableId,
        startRow: start.row,
        startCol: start.col,
        endRow: end.row,
        endCol: end.col,
      },
    })
  }

  const handleSelectionStart = (event, target) => {
    event.preventDefault()
    handleCellFocus(target)

    if (event.shiftKey && state.activeCell && state.activeCell.tableId === target.tableId) {
      setSelectionRange(state.activeCell, target)
      setIsSelecting(false)
      setSelectionAnchor(null)
      return
    }

    setSelectionRange(target, target)
    setSelectionAnchor(target)
    setIsSelecting(true)
  }

  const handleSelectionHover = (target) => {
    if (isSelecting && selectionAnchor && selectionAnchor.tableId === target.tableId) {
      setSelectionRange(selectionAnchor, target)
      return
    }
    if (!isSelecting) {
      handleCellFocus(target)
    }
  }

  const handleClearSelection = () => {
    dispatch({ type: 'setCellSelection', selection: null })
    setIsSelecting(false)
    setSelectionAnchor(null)
  }

  const handleMergeSelection = async () => {
    if (!canMergeSelection || !onMergeCells) {
      return
    }
    const didMerge = await onMergeCells({
      tableId: normalizedSelection.tableId,
      startRow: normalizedSelection.startRow,
      startCol: normalizedSelection.startCol,
      endRow: normalizedSelection.endRow,
      endCol: normalizedSelection.endCol,
    })
    if (didMerge) {
      setIsSelecting(false)
      setSelectionAnchor(null)
    }
  }

  const handleUnmergeSelection = async () => {
    if (!canUnmergeAnchor || !onUnmergeCell) {
      return
    }
    const didUnmerge = await onUnmergeCell({
      tableId: normalizedSelection.tableId,
      row: normalizedSelection.startRow,
      col: normalizedSelection.startCol,
    })
    if (didUnmerge) {
      setIsSelecting(false)
      setSelectionAnchor(null)
    }
  }

  const isTargetSelected = (target) => {
    if (!normalizedSelection || normalizedSelection.tableId !== target.tableId) {
      return false
    }
    return (
      target.row >= normalizedSelection.startRow
      && target.row <= normalizedSelection.endRow
      && target.col >= normalizedSelection.startCol
      && target.col <= normalizedSelection.endCol
    )
  }

  const handleStartEdit = (target, currentText) => {
    handleCellFocus(target)
    setEditingCell(target)
    setDraft(currentText || '')
  }

  const handleCommitEdit = async (target, direction = null) => {
    const nextText = cleanCellText(draft)
    const didSave = await onEditCell(target, nextText, { historyMode: 'record' })
    if (!didSave) {
      return
    }
    setEditingCell(null)
    setDraft('')

    const table = activePageTables.find((item) => item.table_id === target.tableId)
    const model = buildTableModel(table)
    const adjacent = direction ? findAdjacentCell(model, target.row, target.col, direction) : null
    const nextTarget = adjacent
      ? { tableId: table.table_id, row: adjacent.row, col: adjacent.col }
      : target
    window.requestAnimationFrame(() => focusCell(nextTarget))
  }

  const handleUndoableClear = async (target) => {
    const didSave = await onEditCell(target, '', { historyMode: 'record' })
    if (didSave) {
      window.requestAnimationFrame(() => focusCell(target))
    }
  }

  useEffect(() => {
    if (!state.activeCell) {
      return
    }
    dispatch({
      type: 'setCellSelection',
      selection: {
        tableId: state.activeCell.tableId,
        startRow: state.activeCell.row,
        startCol: state.activeCell.col,
        endRow: state.activeCell.row,
        endCol: state.activeCell.col,
      },
    })
  }, [dispatch, state.activeCell])

  const renderTable = (table) => {
    const model = buildTableModel(table)
    return (
      <section
        key={table.table_id}
        className={`studio-table-card${state.activeTable === table.table_id ? ' is-active' : ''}`}
        onMouseEnter={() => dispatch({ type: 'setActiveTable', tableId: table.table_id })}
      >
        <div className="studio-table-card-header">
          <div>
            <h4>Table {table.table_id + 1}</h4>
            <p>Detection confidence {scoreLabel(table.td_score)}</p>
          </div>
        </div>

        <div className="studio-table-scroll">
          <table className="studio-table-grid">
            <tbody>
              {Array.from({ length: model.rowCount }, (_, rowIndex) => (
                <tr key={rowIndex}>
                  {Array.from({ length: model.colCount }, (_, colIndex) => {
                    const positionKey = `${rowIndex},${colIndex}`
                    if (model.covered.has(positionKey)) {
                      return null
                    }

                    const cell = model.anchors.get(positionKey)
                    if (!cell) {
                      return <td key={positionKey} className="studio-cell studio-cell-missing" />
                    }

                    const target = { tableId: table.table_id, row: cell.row, col: cell.col }
                    const key = getCellKey(table.table_id, cell.row, cell.col)
                    const isActive = isSameCell(state.activeCell, target)
                    const isSelected = isTargetSelected(target)
                    const isEditing = isSameCell(editingCell, target)
                    const isEmpty = !cell.text
                    const cellStyle = state.showHeatmap
                      ? { background: isActive ? 'rgba(221, 107, 32, 0.1)' : heatmapColor(cell.ocr_score, 0.18) }
                      : undefined

                    return (
                      <td
                        key={positionKey}
                        ref={(node) => {
                          if (node) {
                            cellRefs.current.set(key, node)
                          } else {
                            cellRefs.current.delete(key)
                          }
                        }}
                        rowSpan={cell.row_span > 1 ? cell.row_span : undefined}
                        colSpan={cell.col_span > 1 ? cell.col_span : undefined}
                        tabIndex={0}
                        className={[
                          'studio-cell',
                          isActive ? 'is-active' : '',
                          isSelected ? 'is-selected' : '',
                          isEmpty ? 'is-empty' : '',
                          isEditing ? 'is-editing' : '',
                        ].filter(Boolean).join(' ')}
                        style={cellStyle}
                        title={`OCR confidence ${scoreLabel(cell.ocr_score)}`}
                        onFocus={() => handleCellFocus(target)}
                        onMouseDown={(event) => handleSelectionStart(event, target)}
                        onMouseEnter={() => handleSelectionHover(target)}
                        onDoubleClick={() => handleStartEdit(target, cell.text || '')}
                        onKeyDown={async (event) => {
                          if (isEditing) {
                            return
                          }

                          if (event.key === 'Delete' || event.key === 'Backspace') {
                            event.preventDefault()
                            await handleUndoableClear(target)
                            return
                          }

                          const directionMap = {
                            ArrowUp: 'up',
                            ArrowDown: 'down',
                            ArrowLeft: 'left',
                            ArrowRight: 'right',
                          }
                          const direction = directionMap[event.key]
                          if (!direction) {
                            return
                          }

                          event.preventDefault()
                          const adjacent = findAdjacentCell(model, cell.row, cell.col, direction)
                          if (!adjacent) {
                            return
                          }
                          const nextTarget = { tableId: table.table_id, row: adjacent.row, col: adjacent.col }
                          handleCellFocus(nextTarget)
                          window.requestAnimationFrame(() => focusCell(nextTarget))
                        }}
                      >
                        {isEditing ? (
                          <textarea
                            className="studio-grid-editor"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => { void handleCommitEdit(target) }}
                            onKeyDown={async (event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault()
                                setEditingCell(null)
                                setDraft('')
                                window.requestAnimationFrame(() => focusCell(target))
                                return
                              }
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault()
                                await handleCommitEdit(target, 'down')
                                return
                              }
                              if (event.key === 'Tab') {
                                event.preventDefault()
                                await handleCommitEdit(target, 'right')
                              }
                            }}
                            autoFocus
                          />
                        ) : (
                          <span className="studio-cell-text">{cell.text || ''}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    )
  }

  return (
    <section className="studio-panel studio-grid-pane">
      <div className="studio-grid-context">
        <span>Viewing: Page {state.activePage + 1}</span>
        <span>{contextTable ? `Table ${contextTable.table_id + 1}` : 'No table on this page'}</span>
      </div>

      {contextTable && (
        <div className="studio-grid-ops">
          <span className="studio-grid-ops-label">
            {normalizedSelection
              ? `Selection: ${normalizedSelection.rowCount}x${normalizedSelection.colCount}`
              : 'Selection: none'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { void handleMergeSelection() }}
            disabled={!canMergeSelection}
          >
            Merge Cells
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { void handleUnmergeSelection() }}
            disabled={!canUnmergeAnchor}
          >
            Unmerge
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleClearSelection}
            disabled={!normalizedSelection}
          >
            Clear
          </button>
        </div>
      )}

      <div className="studio-grid-scroll">
        {activePageTables.length ? (
          activePageTables.map(renderTable)
        ) : (
          <div className="studio-empty-state">
            No tables were detected on page {state.activePage + 1}.
          </div>
        )}
      </div>
    </section>
  )
}
