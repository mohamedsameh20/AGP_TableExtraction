import { useState, useCallback } from 'react'

const API = ''

function confidenceColor(score) {
  if (score === null || score === undefined) return 'var(--confidence-none)'
  if (score >= 0.85) return 'var(--confidence-high)'
  if (score >= 0.50) return 'var(--confidence-med)'
  return 'var(--confidence-low)'
}

export default function TableGrid({ tables, jobId }) {
  const [activeTab, setActiveTab] = useState(0)
  const [editingCell, setEditingCell] = useState(null)
  const [editedCells, setEditedCells] = useState(new Set())

  const handleCellDoubleClick = useCallback((tableId, row, col, currentText) => {
    setEditingCell({ tableId, row, col, text: currentText })
  }, [])

  const handleCellSave = useCallback(async (tableId, row, col, newText) => {
    setEditingCell(null)
    if (!jobId) return
    try {
      const res = await fetch(`${API}/api/results/${jobId}/cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table_id: tableId, row, col, text: newText }),
      })
      if (res.ok) {
        // Update local state
        const table = tables[activeTab]
        if (table) {
          const cell = table.cells?.find(c => c.row === row && c.col === col)
          if (cell) cell.text = newText
        }
        setEditedCells(prev => new Set(prev).add(`${tableId}:${row}:${col}`))
      }
    } catch (err) {
      console.error('Cell edit failed:', err)
    }
  }, [jobId, tables, activeTab])

  const handleKeyDown = useCallback((e, tableId, row, col) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCellSave(tableId, row, col, e.target.innerText)
    }
    if (e.key === 'Escape') {
      setEditingCell(null)
    }
  }, [handleCellSave])

  if (!tables.length) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
        No tables detected.
      </div>
    )
  }

  const table = tables[activeTab] || tables[0]
  const cells = table.cells || []

  if (!cells.length) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
        No cells in this table.
      </div>
    )
  }

  // Build grid
  const maxRow = Math.max(...cells.map(c => c.row + c.row_span))
  const maxCol = Math.max(...cells.map(c => c.col + c.col_span))

  // Track covered positions (from spanning cells)
  const covered = new Set()
  const cellMap = {}
  for (const cell of cells) {
    cellMap[`${cell.row},${cell.col}`] = cell
    if (cell.row_span > 1 || cell.col_span > 1) {
      for (let r = cell.row; r < cell.row + cell.row_span; r++) {
        for (let c = cell.col; c < cell.col + cell.col_span; c++) {
          if (r !== cell.row || c !== cell.col) {
            covered.add(`${r},${c}`)
          }
        }
      }
    }
  }

  const isEditing = (row, col) =>
    editingCell && editingCell.tableId === table.table_id && editingCell.row === row && editingCell.col === col

  const wasEdited = (row, col) =>
    editedCells.has(`${table.table_id}:${row}:${col}`)

  return (
    <div>
      {tables.length > 1 && (
        <div className="table-tabs">
          {tables.map((t, i) => (
            <button
              key={t.table_id}
              className={`table-tab${i === activeTab ? ' active' : ''}`}
              onClick={() => setActiveTab(i)}
            >
              Table {t.table_id}
              {t.td_score !== null && t.td_score !== undefined && (
                <span className="table-tab-score" style={{ color: confidenceColor(t.td_score) }}>
                  {Math.round(t.td_score * 100)}%
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="table-edit-hint">
        💡 Double-click any cell to edit its text before exporting
      </div>
      <div className="table-grid-container">
        <table className="extracted-table">
          <tbody>
            {Array.from({ length: maxRow }, (_, r) => (
              <tr key={r}>
                {Array.from({ length: maxCol }, (_, c) => {
                  const key = `${r},${c}`
                  if (covered.has(key)) return null
                  const cell = cellMap[key]
                  if (!cell) return <td key={c}></td>

                  const editing = isEditing(r, c)
                  const edited = wasEdited(r, c)
                  const score = cell.ocr_score

                  return (
                    <td
                      key={c}
                      rowSpan={cell.row_span > 1 ? cell.row_span : undefined}
                      colSpan={cell.col_span > 1 ? cell.col_span : undefined}
                      className={`${editing ? 'cell-editing' : ''} ${edited ? 'cell-edited' : ''}`}
                      style={{
                        borderLeftColor: confidenceColor(score),
                        borderLeftWidth: 3,
                        ...(r === 0 ? { fontWeight: 600, background: 'var(--bg-elevated)' } : {}),
                      }}
                      title={score != null ? `OCR confidence: ${Math.round(score * 100)}%` : 'No OCR score'}
                      onDoubleClick={() => handleCellDoubleClick(table.table_id, r, c, cell.text || '')}
                    >
                      {editing ? (
                        <div
                          className="cell-editor"
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={(e) => handleCellSave(table.table_id, r, c, e.target.innerText)}
                          onKeyDown={(e) => handleKeyDown(e, table.table_id, r, c)}
                          ref={(el) => { if (el) { el.focus(); el.innerText = editingCell.text } }}
                        />
                      ) : (
                        cell.text || ''
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
