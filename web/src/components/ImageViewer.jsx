import { useRef, useEffect, useState } from 'react'

function confidenceColor(score, alpha = 1) {
  if (score === null || score === undefined) return `rgba(99, 102, 241, ${0.6 * alpha})`
  if (score >= 0.85) return `rgba(34, 197, 94, ${alpha})`
  if (score >= 0.50) return `rgba(245, 158, 11, ${alpha})`
  return `rgba(239, 68, 68, ${alpha})`
}

export default function ImageViewer({ imageUrl, tables }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [imgLoaded, setImgLoaded] = useState(false)
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

    // Draw table bounding boxes with confidence-coded colors
    for (const table of tables) {
      const [x1, y1, x2, y2] = table.bbox
      const sx = x1 * scale, sy = y1 * scale
      const sw = (x2 - x1) * scale, sh = (y2 - y1) * scale
      const tdScore = table.td_score

      ctx.save()
      ctx.strokeStyle = confidenceColor(tdScore, 0.9)
      ctx.lineWidth = 2.5
      ctx.setLineDash([6, 4])
      ctx.strokeRect(sx, sy, sw, sh)
      ctx.fillStyle = confidenceColor(tdScore, 0.06)
      ctx.fillRect(sx, sy, sw, sh)

      // Confidence label
      const labelText = tdScore != null ? `Table ${table.table_id} (${Math.round(tdScore * 100)}%)` : `Table ${table.table_id}`
      ctx.font = `600 ${Math.max(11, Math.min(14, sw * 0.03))}px Inter, sans-serif`
      const metrics = ctx.measureText(labelText)
      const lx = sx + 4, ly = sy - 6
      if (ly > 14) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)'
        ctx.fillRect(lx - 2, ly - 12, metrics.width + 8, 16)
        ctx.fillStyle = '#fff'
        ctx.fillText(labelText, lx + 2, ly)
      }
      ctx.restore()

      // Draw cell bounding boxes
      for (const cell of (table.cells || [])) {
        const [cx1, cy1, cx2, cy2] = cell.bbox
        const csx = cx1 * scale, csy = cy1 * scale
        const csw = (cx2 - cx1) * scale, csh = (cy2 - cy1) * scale

        ctx.save()
        ctx.strokeStyle = confidenceColor(cell.ocr_score, 0.5)
        ctx.lineWidth = 1
        ctx.setLineDash([])
        ctx.strokeRect(csx, csy, csw, csh)
        ctx.restore()
      }
    }
  }, [imgLoaded, tables])

  return (
    <div ref={containerRef} className="image-viewer">
      <canvas ref={canvasRef} style={{ display: imgLoaded ? 'block' : 'none' }} />
      {!imgLoaded && (
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading image...</div>
      )}
    </div>
  )
}
