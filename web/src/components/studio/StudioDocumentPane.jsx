import { useEffect, useMemo, useRef, useState } from 'react'
import { Image as KonvaImage, Layer, Rect, Stage, Text } from 'react-konva'
import { useStudio } from './StudioContext'
import {
  clamp,
  confidenceStroke,
  getCellKey,
  getPages,
  getTablesForPage,
  heatmapColor,
  isSameCell,
} from './studioUtils'

const API = ''

function useLoadedImage(src, onError) {
  const [image, setImage] = useState(null)

  useEffect(() => {
    const nextImage = new window.Image()
    nextImage.crossOrigin = 'anonymous'
    nextImage.onload = () => setImage(nextImage)
    nextImage.onerror = () => {
      setImage(null)
      onError?.()
    }
    nextImage.src = src
    return () => {
      nextImage.onload = null
      nextImage.onerror = null
    }
  }, [onError, src])

  return image
}

function TableLabel({ table, scale }) {
  const label = `Table ${table.table_id + 1}`
  const x = table.bbox[0] * scale + 8
  const y = Math.max(12, table.bbox[1] * scale - 18)

  return (
    <Text
      x={x}
      y={y}
      text={label}
      fontSize={12}
      fontStyle="bold"
      fill="#1F2937"
    />
  )
}

function StudioPageCanvas({
  page,
  tables,
  stageWidth,
  onImageError,
  onCopyText,
  onSelectionEnd,
}) {
  const { state, dispatch } = useStudio()
  const [hoveredOcrKey, setHoveredOcrKey] = useState(null)
  const imageUrl = `${API}/api/image/${page.jobId}?page=${page.page_index}`
  const image = useLoadedImage(imageUrl, onImageError)
  const [pageWidth, pageHeight] = page.image_size || [0, 0]
  const safeWidth = Math.max(1, pageWidth || image?.naturalWidth || stageWidth || 1)
  const safeHeight = Math.max(1, pageHeight || image?.naturalHeight || 1)
  const drawnWidth = stageWidth ? Math.min(safeWidth, Math.max(240, stageWidth)) : safeWidth
  const scale = drawnWidth / safeWidth
  const stageHeight = safeHeight * scale

  const visibleTables = tables.filter((table) => (table.td_score ?? 0) >= state.tdThreshold)

  const selectionRect = state.selection && state.selection.pageIndex === page.page_index
    ? {
      left: Math.min(state.selection.start.x, state.selection.current.x),
      top: Math.min(state.selection.start.y, state.selection.current.y),
      right: Math.max(state.selection.start.x, state.selection.current.x),
      bottom: Math.max(state.selection.start.y, state.selection.current.y),
    }
    : null

  const handleMouseDown = (e) => {
    if (state.activeTool !== 'marquee') return
    const stage = e.target.getStage()
    const pos = stage?.getPointerPosition()
    if (!pos) {
      return
    }
    dispatch({
      type: 'setSelection',
      selection: {
        pageIndex: page.page_index,
        start: { x: pos.x / scale, y: pos.y / scale },
        current: { x: pos.x / scale, y: pos.y / scale },
      }
    })
  }

  const handleMouseMove = (e) => {
    if (state.activeTool !== 'marquee' || !state.selection || state.selection.pageIndex !== page.page_index) return
    const stage = e.target.getStage()
    const pos = stage?.getPointerPosition()
    if (!pos) {
      return
    }
    dispatch({
      type: 'setSelection',
      selection: {
        ...state.selection,
        current: { x: pos.x / scale, y: pos.y / scale },
      }
    })
  }

  const handleMouseUp = () => {
    if (state.activeTool !== 'marquee' || !state.selection || state.selection.pageIndex !== page.page_index) return
    const { start, current } = state.selection
    const bbox = [
      Math.min(start.x, current.x),
      Math.min(start.y, current.y),
      Math.max(start.x, current.x),
      Math.max(start.y, current.y),
    ]
    if (Math.abs(bbox[2] - bbox[0]) > 5 && Math.abs(bbox[3] - bbox[1]) > 5) {
      onSelectionEnd?.({
        bbox,
        clientX: ((bbox[0] + bbox[2]) / 2) * scale,
        clientY: (bbox[1] * scale) - 16,
      })
    } else {
      dispatch({ type: 'setSelection', selection: null })
    }
  }

  return (
    <div className="document-page-card">
      <Stage
        width={drawnWidth}
        height={stageHeight}
        className="document-stage"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <Layer>
          {image && (
            <KonvaImage
              image={image}
              width={drawnWidth}
              height={stageHeight}
            />
          )}

          {visibleTables.map((table) => {
            const isActiveTable = state.activeTable === table.table_id
            const [x1, y1, x2, y2] = table.bbox
            const width = (x2 - x1) * scale
            const height = (y2 - y1) * scale
            const x = x1 * scale
            const y = y1 * scale
            return (
              <Rect
                key={`table-${table.table_id}`}
                x={x}
                y={y}
                width={width}
                height={height}
                stroke={isActiveTable ? '#DD6B20' : confidenceStroke(table.td_score)}
                strokeWidth={isActiveTable ? 3 : 2}
                dash={isActiveTable ? [] : [8, 6]}
                fill={state.showHeatmap ? heatmapColor(table.td_score, isActiveTable ? 0.18 : 0.09) : 'transparent'}
                onClick={() => dispatch({ type: 'setActiveTable', tableId: table.table_id })}
              />
            )
          })}

          {visibleTables.map((table) => (
            <TableLabel key={`label-${table.table_id}`} table={table} scale={scale} />
          ))}

          {visibleTables.flatMap((table) => (table.cells || []).map((cell) => {
            const key = getCellKey(table.table_id, cell.row, cell.col)
            const selected = isSameCell(state.activeCell, {
              tableId: table.table_id,
              row: cell.row,
              col: cell.col,
            })
            const [x1, y1, x2, y2] = cell.bbox
            const x = x1 * scale
            const y = y1 * scale
            const width = (x2 - x1) * scale
            const height = (y2 - y1) * scale
            const visibleStroke = state.showTableGrid ? '#E5E7EB' : 'transparent'
            const visibleFill = selected
              ? 'rgba(221, 107, 32, 0.18)'
              : state.showHeatmap && state.showTableGrid
                ? heatmapColor(cell.ocr_score, 0.14)
                : 'transparent'
            return (
              <Rect
                key={`cell-${key}`}
                x={x}
                y={y}
                width={width}
                height={height}
                stroke={selected ? '#DD6B20' : visibleStroke}
                strokeWidth={selected ? 2 : 1}
                fill={visibleFill}
                onMouseEnter={() => {
                  dispatch({ type: 'setActiveTable', tableId: table.table_id })
                  dispatch({ type: 'setActiveCell', cell: { tableId: table.table_id, row: cell.row, col: cell.col } })
                }}
                onClick={() => {
                  dispatch({ type: 'setActiveTable', tableId: table.table_id })
                  dispatch({ type: 'setActiveCell', cell: { tableId: table.table_id, row: cell.row, col: cell.col } })
                }}
                listening
                perfectDrawEnabled={false}
              />
            )
          }))}

          {state.showTextBoxes && visibleTables.flatMap((table) => (table.ocr_items || []).map((item, index) => {
            const key = `${table.table_id}:${index}`
            const [x1, y1, x2, y2] = item.bbox
            const x = x1 * scale
            const y = y1 * scale
            const width = Math.max(1, (x2 - x1) * scale)
            const height = Math.max(1, (y2 - y1) * scale)
            const hovered = hoveredOcrKey === key
            return (
              <Rect
                key={`ocr-${key}`}
                x={x}
                y={y}
                width={width}
                height={height}
                stroke={hovered ? '#DD6B20' : 'rgba(221, 107, 32, 0.35)'}
                strokeWidth={hovered ? 1.5 : 1}
                fill={hovered ? 'rgba(221, 107, 32, 0.15)' : 'transparent'}
                onMouseEnter={() => setHoveredOcrKey(key)}
                onMouseLeave={() => setHoveredOcrKey((current) => (current === key ? null : current))}
                onClick={(event) => onCopyText(item.text || '', event.evt.clientX, event.evt.clientY)}
              />
            )
          }))}

          {selectionRect && (
            <Rect
              x={selectionRect.left * scale}
              y={selectionRect.top * scale}
              width={(selectionRect.right - selectionRect.left) * scale}
              height={(selectionRect.bottom - selectionRect.top) * scale}
              fill="rgba(229, 115, 0, 0.1)"
              stroke="#E57300"
              strokeWidth={1}
              dash={[4, 2]}
            />
          )}
        </Layer>
      </Stage>
      
      {selectionRect && state.activeTool === 'marquee' && (
        <div 
          className="marquee-fab"
          style={{
            left: (selectionRect.right * scale) + 10,
            top: Math.max(6, (selectionRect.top * scale) - 8),
          }}
        >
          <button 
            type="button" 
            className="btn btn-sm btn-primary"
            onClick={() => {
              onSelectionEnd?.({
                bbox: [selectionRect.left, selectionRect.top, selectionRect.right, selectionRect.bottom],
                clientX: ((selectionRect.left + selectionRect.right) / 2) * scale,
                clientY: (selectionRect.top * scale) - 16,
              })
            }}
          >
            Re-run OCR here
          </button>
        </div>
      )}
    </div>
  )
}

export default function StudioDocumentPane({ annotation, jobId, onCopyText, onSelectionEnd }) {
  const { state, dispatch } = useStudio()
  const scrollRef = useRef(null)
  const measureRef = useRef(null)
  const pageRefs = useRef([])
  const [stageWidth, setStageWidth] = useState(720)
  const pages = useMemo(
    () => getPages(annotation).map((page) => ({ ...page, jobId })),
    [annotation, jobId],
  )

  useEffect(() => {
    const node = measureRef.current
    if (!node) {
      return undefined
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      const width = entry?.contentRect?.width || node.clientWidth
      setStageWidth(clamp(width - 48, 280, 1200))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const root = scrollRef.current
    const targets = pageRefs.current.filter(Boolean)
    if (!root || targets.length === 0) {
      return undefined
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries.filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)
        if (!visibleEntries.length) {
          return
        }
        const mostVisible = visibleEntries.reduce((best, entry) => (
          entry.intersectionRatio > best.intersectionRatio ? entry : best
        ))
        const pageIndex = Number(mostVisible.target.getAttribute('data-page-index'))
        if (!Number.isNaN(pageIndex) && pageIndex !== state.activePage) {
          dispatch({ type: 'setActivePage', page: pageIndex })
        }
      },
      {
        root,
        threshold: [0.5, 0.75],
      },
    )

    for (const target of targets) {
      observer.observe(target)
    }

    return () => observer.disconnect()
  }, [dispatch, state.activePage, pages.length])

  return (
    <section className="studio-panel studio-document-pane">
      <div className="studio-toolbar">
        <label className="studio-threshold-control">
          <span className="studio-threshold-label">Didn&apos;t find your table? Adjust sensitivity.</span>
          <div className="studio-threshold-row">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={state.tdThreshold}
              onChange={(event) => dispatch({ type: 'setThreshold', value: Number(event.target.value) })}
            />
            <span className="studio-threshold-value">{state.tdThreshold.toFixed(2)}</span>
          </div>
        </label>

        <div className="studio-toolbar-toggles">
          <button
            type="button"
            className={`studio-toggle${state.showTableGrid ? ' is-active' : ''}`}
            onClick={() => dispatch({ type: 'toggleFlag', flag: 'showTableGrid' })}
          >
            Toggle Table Grid
          </button>
          <button
            type="button"
            className={`studio-toggle${state.showTextBoxes ? ' is-active' : ''}`}
            onClick={() => dispatch({ type: 'toggleFlag', flag: 'showTextBoxes' })}
          >
            Toggle Text BBoxes
          </button>
          <button
            type="button"
            className={`studio-toggle${state.showHeatmap ? ' is-active' : ''}`}
            onClick={() => dispatch({ type: 'toggleFlag', flag: 'showHeatmap' })}
          >
            Heatmap Overlay
          </button>
        </div>

        <div className="studio-toolbar-toggles studio-tool-select">
          <button
            type="button"
            className={`studio-toggle${state.activeTool === 'pointer' ? ' is-active' : ''}`}
            onClick={() => dispatch({ type: 'setTool', tool: 'pointer' })}
          >
            Pointer
          </button>
          <button
            type="button"
            className={`studio-toggle${state.activeTool === 'marquee' ? ' is-active' : ''}`}
            onClick={() => dispatch({ type: 'setTool', tool: 'marquee' })}
          >
            Marquee OCR
          </button>
        </div>
      </div>

      <div className="studio-document-scroll" ref={scrollRef}>
        <div className="studio-document-stack" ref={measureRef}>
          {pages.map((page, index) => (
            <section
              key={page.page_index}
              ref={(node) => { pageRefs.current[index] = node }}
              className="document-page"
              data-page-index={page.page_index}
            >
              <div className="document-page-meta">Page {page.page_index + 1}</div>
              <StudioPageCanvas
                page={page}
                tables={getTablesForPage(annotation, page.page_index)}
                stageWidth={stageWidth}
                onImageError={() => dispatch({ type: 'incrementErrors' })}
                onCopyText={onCopyText}
                onSelectionEnd={onSelectionEnd}
              />
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}
