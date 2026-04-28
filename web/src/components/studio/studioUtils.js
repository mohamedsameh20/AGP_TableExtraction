export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

export function cleanCellText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function getPages(annotation) {
  if (annotation?.pages?.length) {
    return annotation.pages
  }
  return [{ page_index: 0, image_size: annotation?.image_size || [0, 0] }]
}

export function getTablesForPage(annotation, pageIndex) {
  return (annotation?.tables || [])
    .filter((table) => (table.page || 0) === pageIndex)
    .sort((a, b) => a.table_id - b.table_id)
}

export function getTableById(annotation, tableId) {
  return (annotation?.tables || []).find((table) => table.table_id === tableId) || null
}

export function getCellKey(tableId, row, col) {
  return `${tableId}:${row}:${col}`
}

export function isSameCell(a, b) {
  if (!a || !b) {
    return false
  }
  return a.tableId === b.tableId && a.row === b.row && a.col === b.col
}

export function findCell(annotation, target) {
  if (!target) {
    return null
  }
  const table = getTableById(annotation, target.tableId)
  if (!table) {
    return null
  }
  const cell = (table.cells || []).find((item) => item.row === target.row && item.col === target.col)
  if (!cell) {
    return null
  }
  return { table, cell }
}

export function updateAnnotationCell(annotation, target, text) {
  return {
    ...annotation,
    tables: (annotation.tables || []).map((table) => {
      if (table.table_id !== target.tableId) {
        return table
      }
      return {
        ...table,
        cells: (table.cells || []).map((cell) => (
          cell.row === target.row && cell.col === target.col
            ? { ...cell, text }
            : cell
        )),
      }
    }),
  }
}

export function confidenceStroke(score) {
  if (score === null || score === undefined) {
    return '#9CA3AF'
  }
  if (score >= 0.8) {
    return '#16A34A'
  }
  if (score >= 0.5) {
    return '#D97706'
  }
  return '#DC2626'
}

export function heatmapColor(score, alpha = 0.18) {
  if (score === null || score === undefined) {
    return `rgba(229, 231, 235, ${alpha})`
  }
  if (score >= 0.8) {
    return `rgba(22, 163, 74, ${alpha})`
  }
  if (score >= 0.5) {
    return `rgba(217, 119, 6, ${alpha})`
  }
  return `rgba(220, 38, 38, ${alpha})`
}

export function buildTableModel(table) {
  const cells = table?.cells || []
  const rowCount = cells.length ? Math.max(...cells.map((cell) => cell.row + cell.row_span)) : 0
  const colCount = cells.length ? Math.max(...cells.map((cell) => cell.col + cell.col_span)) : 0
  const anchors = new Map()
  const covered = new Set()
  const occupancy = new Map()

  for (const cell of cells) {
    const anchorKey = `${cell.row},${cell.col}`
    anchors.set(anchorKey, cell)
    for (let row = cell.row; row < cell.row + cell.row_span; row += 1) {
      for (let col = cell.col; col < cell.col + cell.col_span; col += 1) {
        const positionKey = `${row},${col}`
        occupancy.set(positionKey, cell)
        if (row !== cell.row || col !== cell.col) {
          covered.add(positionKey)
        }
      }
    }
  }

  return {
    rowCount,
    colCount,
    anchors,
    covered,
    occupancy,
  }
}

export function findAdjacentCell(model, row, col, direction) {
  if (!model) {
    return null
  }
  const deltas = {
    up: [-1, 0],
    down: [1, 0],
    left: [0, -1],
    right: [0, 1],
  }
  const delta = deltas[direction]
  if (!delta) {
    return null
  }
  let nextRow = row + delta[0]
  let nextCol = col + delta[1]
  while (nextRow >= 0 && nextCol >= 0 && nextRow < model.rowCount && nextCol < model.colCount) {
    const candidate = model.occupancy.get(`${nextRow},${nextCol}`)
    if (candidate && (candidate.row !== row || candidate.col !== col)) {
      return candidate
    }
    nextRow += delta[0]
    nextCol += delta[1]
  }
  return null
}
