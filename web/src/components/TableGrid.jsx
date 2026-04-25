import { useState } from 'react'

export default function TableGrid({ tables }) {
  const [activeTab, setActiveTab] = useState(0)

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
            </button>
          ))}
        </div>
      )}
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
                  return (
                    <td
                      key={c}
                      rowSpan={cell.row_span > 1 ? cell.row_span : undefined}
                      colSpan={cell.col_span > 1 ? cell.col_span : undefined}
                      style={r === 0 ? { fontWeight: 600, background: 'var(--bg-elevated)' } : undefined}
                    >
                      {cell.text || ''}
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
