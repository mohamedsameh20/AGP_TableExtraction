import { useRef, useEffect, useState } from 'react'

export default function ImageViewer({ imageUrl, tables }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [hoveredCell, setHoveredCell] = useState(null)
  const imgRef = useRef(null)

  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      setImgLoaded(true)
    }
    img.src = imageUrl
    return () => { img.onload = null }
  }, [imageUrl])

  useEffect(() => {
    if (!imgLoaded || !canvasRef.current || !imgRef.current) return
    const canvas = canvasRef.current
    const container = containerRef.current
    const img = imgRef.current

    // Fit image to container
    const containerRect = container.getBoundingClientRect()
    const scaleX = containerRect.width / img.naturalWidth
    const scaleY = containerRect.height / img.naturalHeight
    const scale = Math.min(scaleX, scaleY, 1)

    canvas.width = Math.floor(img.naturalWidth * scale)
    canvas.height = Math.floor(img.naturalHeight * scale)

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    // Draw table bounding boxes
    for (const table of tables) {
      const [x1, y1, x2, y2] = table.bbox
      const sx = x1 * scale, sy = y1 * scale
      const sw = (x2 - x1) * scale, sh = (y2 - y1) * scale

      ctx.save()
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.8)'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.strokeRect(sx, sy, sw, sh)
      ctx.fillStyle = 'rgba(99, 102, 241, 0.06)'
      ctx.fillRect(sx, sy, sw, sh)
      ctx.restore()

      // Draw cell bounding boxes
      for (const cell of (table.cells || [])) {
        const [cx1, cy1, cx2, cy2] = cell.bbox
        const csx = cx1 * scale, csy = cy1 * scale
        const csw = (cx2 - cx1) * scale, csh = (cy2 - cy1) * scale

        const isHovered = hoveredCell &&
          hoveredCell.row === cell.row &&
          hoveredCell.col === cell.col &&
          hoveredCell.tableId === table.table_id

        ctx.save()
        if (isHovered) {
          ctx.strokeStyle = 'rgba(139, 92, 246, 1)'
          ctx.lineWidth = 2
          ctx.fillStyle = 'rgba(139, 92, 246, 0.2)'
          ctx.fillRect(csx, csy, csw, csh)
        } else {
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.5)'
          ctx.lineWidth = 1
        }
        ctx.setLineDash([])
        ctx.strokeRect(csx, csy, csw, csh)
        ctx.restore()
      }
    }
  }, [imgLoaded, tables, hoveredCell])

  return (
    <div ref={containerRef} className="image-viewer">
      <canvas ref={canvasRef} style={{ display: imgLoaded ? 'block' : 'none' }} />
      {!imgLoaded && (
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading image...</div>
      )}
    </div>
  )
}
