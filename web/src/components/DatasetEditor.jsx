import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

const CATEGORY_COLORS = {
  'table': '#ff6b6b',
  'table column': '#4dabf7',
  'table row': '#51cf66',
  'table column header': '#fcc419',
  'table projected row header': '#c77dff',
  'table spanning cell': '#ff922b',
  'cell': '#63e6be',
}

const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function normalizeRectFromPoints(start, end, width, height) {
  const x1 = clamp(Math.min(start.x, end.x), 0, width)
  const y1 = clamp(Math.min(start.y, end.y), 0, height)
  const x2 = clamp(Math.max(start.x, end.x), 0, width)
  const y2 = clamp(Math.max(start.y, end.y), 0, height)
  return [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)]
}

function clampBbox(bbox, width, height) {
  let [x, y, w, h] = bbox.map(Number)
  if (w < 0) {
    x += w
    w = Math.abs(w)
  }
  if (h < 0) {
    y += h
    h = Math.abs(h)
  }
  x = clamp(x, 0, width)
  y = clamp(y, 0, height)
  w = clamp(w, 1, width - x)
  h = clamp(h, 1, height - y)
  return [Number(x.toFixed(2)), Number(y.toFixed(2)), Number(w.toFixed(2)), Number(h.toFixed(2))]
}

function applyResize(startBBox, handle, point, image) {
  const [sx, sy, sw, sh] = startBBox
  let left = sx
  let top = sy
  let right = sx + sw
  let bottom = sy + sh

  if (handle.includes('w')) left = point.x
  if (handle.includes('e')) right = point.x
  if (handle.includes('n')) top = point.y
  if (handle.includes('s')) bottom = point.y

  const normalized = normalizeRectFromPoints(
    { x: left, y: top },
    { x: right, y: bottom },
    image.width,
    image.height,
  )
  return clampBbox(normalized, image.width, image.height)
}

function bboxHandles([x, y, w, h]) {
  const midX = x + w / 2
  const midY = y + h / 2
  return {
    nw: [x, y],
    n: [midX, y],
    ne: [x + w, y],
    e: [x + w, midY],
    se: [x + w, y + h],
    s: [midX, y + h],
    sw: [x, y + h],
    w: [x, midY],
  }
}

function countByCategory(annotations, categories) {
  const counts = {}
  for (const category of categories) counts[category.name] = 0
  for (const annotation of annotations) {
    const category = categories.find((item) => item.id === annotation.category_id)
    const name = category?.name ?? 'unknown'
    counts[name] = (counts[name] || 0) + 1
  }
  return counts
}

function DatasetEditor() {
  const stageRef = useRef(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [activeImageId, setActiveImageId] = useState(null)
  const [imageData, setImageData] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [zoom, setZoom] = useState(0.72)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingImage, setLoadingImage] = useState(false)
  const [dragState, setDragState] = useState(null)
  const [createMode, setCreateMode] = useState(false)
  const [createCategoryId, setCreateCategoryId] = useState(5)
  const [statusMessage, setStatusMessage] = useState('Loading dataset…')
  const [bulkFromCategoryId, setBulkFromCategoryId] = useState(5)
  const [bulkToCategoryId, setBulkToCategoryId] = useState(4)
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())

  useEffect(() => {
    let cancelled = false
    async function loadMeta() {
      try {
        const response = await fetch('/api/editor/meta')
        if (!response.ok) throw new Error(`Failed to load editor meta (${response.status})`)
        const payload = await response.json()
        if (cancelled) return
        setMeta(payload)
        setStatusMessage(`Loaded ${payload.image_count} images and ${payload.annotation_count} annotations.`)
        if (payload.categories?.length) {
          setCreateCategoryId(payload.categories[0].id)
          setBulkFromCategoryId(payload.categories.find((item) => item.name === 'table projected row header')?.id ?? payload.categories[0].id)
          setBulkToCategoryId(payload.categories.find((item) => item.name === 'table row')?.id ?? payload.categories[0].id)
        }
        if (payload.images?.length) {
          loadImage(payload.images[0].id, { skipDirtyCheck: true })
        }
      } catch (loadError) {
        setError(loadError.message)
      }
    }
    loadMeta()
    return () => {
      cancelled = true
    }
  }, [])

  const categories = meta?.categories ?? []
  const categoryById = useMemo(
    () => Object.fromEntries(categories.map((category) => [category.id, category])),
    [categories],
  )

  const [visibleCategories, setVisibleCategories] = useState(new Set())

  useEffect(() => {
    if (!categories.length) return
    setVisibleCategories(new Set(categories.map((category) => category.id)))
  }, [categories])

  async function loadImage(imageId, { skipDirtyCheck = false } = {}) {
    if (!skipDirtyCheck && dirty) {
      const proceed = window.confirm('You have unsaved changes for this image. Discard them and open another image?')
      if (!proceed) return
    }
    setLoadingImage(true)
    setError('')
    try {
      const response = await fetch(`/api/editor/image/${imageId}`)
      if (!response.ok) throw new Error(`Failed to load image ${imageId} (${response.status})`)
      const payload = await response.json()
      setImageData(payload)
      setActiveImageId(imageId)
      setSelectedId(payload.annotations[0]?.id ?? null)
      setDirty(false)
      setStatusMessage(`Opened ${payload.image.file_name} with ${payload.annotations.length} annotations.`)
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoadingImage(false)
    }
  }

  useEffect(() => {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveCurrentImage()
      }
      if (event.key === 'Delete' && selectedId != null) {
        event.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  useEffect(() => {
    if (!dragState || !imageData) return undefined

    function toImagePoint(event) {
      const rect = stageRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }
      const scaleX = imageData.image.width / rect.width
      const scaleY = imageData.image.height / rect.height
      return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      }
    }

    function handleMove(event) {
      const point = toImagePoint(event)
      if (dragState.kind === 'move') {
        const dx = point.x - dragState.startPoint.x
        const dy = point.y - dragState.startPoint.y
        const [x, y, w, h] = dragState.startBBox
        const next = clampBbox([x + dx, y + dy, w, h], imageData.image.width, imageData.image.height)
        replaceAnnotation(dragState.annotationId, { bbox: next })
      }
      if (dragState.kind === 'resize') {
        const next = applyResize(dragState.startBBox, dragState.handle, point, imageData.image)
        replaceAnnotation(dragState.annotationId, { bbox: next })
      }
      if (dragState.kind === 'create') {
        const next = normalizeRectFromPoints(dragState.startPoint, point, imageData.image.width, imageData.image.height)
        replaceAnnotation(dragState.annotationId, { bbox: next })
      }
    }

    function handleUp() {
      if (dragState.kind === 'create') {
        const created = imageData.annotations.find((annotation) => annotation.id === dragState.annotationId)
        if (created && (created.bbox[2] < 3 || created.bbox[3] < 3)) {
          setImageData((current) => ({
            ...current,
            annotations: current.annotations.filter((annotation) => annotation.id !== dragState.annotationId),
          }))
          setSelectedId(null)
        }
      }
      setDragState(null)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [dragState, imageData])

  const filteredImages = useMemo(() => {
    if (!meta?.images) return []
    if (!deferredSearch) return meta.images
    return meta.images.filter((image) => image.file_name.toLowerCase().includes(deferredSearch))
  }, [meta, deferredSearch])

  const selectedAnnotation = useMemo(
    () => imageData?.annotations.find((annotation) => annotation.id === selectedId) ?? null,
    [imageData, selectedId],
  )

  const visibleAnnotations = useMemo(() => {
    if (!imageData) return []
    return imageData.annotations.filter((annotation) => visibleCategories.has(annotation.category_id))
  }, [imageData, visibleCategories])

  const currentCounts = useMemo(() => {
    if (!imageData) return {}
    return countByCategory(imageData.annotations, categories)
  }, [imageData, categories])

  function replaceAnnotation(annotationId, patch) {
    setImageData((current) => {
      if (!current) return current
      return {
        ...current,
        annotations: current.annotations.map((annotation) => {
          if (annotation.id !== annotationId) return annotation
          const next = { ...annotation, ...patch }
          if (patch.category_id != null) {
            next.category_name = categoryById[patch.category_id]?.name ?? next.category_name
          }
          return next
        }),
      }
    })
    setDirty(true)
  }

  function updateMetaCounts(imageId, annotations) {
    setMeta((current) => {
      if (!current) return current
      const previousImage = current.images.find((image) => image.id === imageId)
      const previousCount = previousImage?.annotation_count ?? 0
      const nextCount = annotations.length
      return {
        ...current,
        annotation_count: current.annotation_count - previousCount + nextCount,
        images: current.images.map((image) => {
          if (image.id !== imageId) return image
          return {
            ...image,
            annotation_count: annotations.length,
            counts_by_category: countByCategory(annotations, current.categories),
          }
        }),
      }
    })
  }

  async function saveCurrentImage() {
    if (!imageData || saving) return
    setSaving(true)
    setError('')
    try {
      const response = await fetch(`/api/editor/image/${imageData.image.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotations: imageData.annotations.map((annotation) => ({
            id: annotation.id > 0 ? annotation.id : null,
            image_id: imageData.image.id,
            category_id: annotation.category_id,
            bbox: annotation.bbox,
            iscrowd: annotation.iscrowd ?? 0,
            ignore: annotation.ignore ?? 0,
          })),
        }),
      })
      if (!response.ok) throw new Error(`Save failed (${response.status})`)
      const payload = await response.json()
      const nextImageData = { ...imageData, annotations: payload.annotations }
      setImageData(nextImageData)
      updateMetaCounts(imageData.image.id, payload.annotations)
      setDirty(false)
      setStatusMessage(`Saved ${payload.saved_count} annotations to ${imageData.image.file_name}.`)
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  function deleteSelected() {
    if (!imageData || selectedId == null) return
    setImageData((current) => ({
      ...current,
      annotations: current.annotations.filter((annotation) => annotation.id !== selectedId),
    }))
    setSelectedId(null)
    setDirty(true)
  }

  function updateSelectedBBox(index, value) {
    if (!selectedAnnotation) return
    const next = [...selectedAnnotation.bbox]
    next[index] = Number(value)
    replaceAnnotation(selectedAnnotation.id, {
      bbox: clampBbox(next, imageData.image.width, imageData.image.height),
    })
  }

  function startMove(annotationId, event) {
    event.stopPropagation()
    const annotation = imageData.annotations.find((item) => item.id === annotationId)
    if (!annotation) return
    setSelectedId(annotationId)
    setDragState({
      kind: 'move',
      annotationId,
      startPoint: pointerToImage(event),
      startBBox: annotation.bbox,
    })
  }

  function startResize(annotationId, handle, event) {
    event.stopPropagation()
    const annotation = imageData.annotations.find((item) => item.id === annotationId)
    if (!annotation) return
    setSelectedId(annotationId)
    setDragState({
      kind: 'resize',
      annotationId,
      handle,
      startPoint: pointerToImage(event),
      startBBox: annotation.bbox,
    })
  }

  function pointerToImage(event) {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || !imageData) return { x: 0, y: 0 }
    return {
      x: ((event.clientX - rect.left) / rect.width) * imageData.image.width,
      y: ((event.clientY - rect.top) / rect.height) * imageData.image.height,
    }
  }

  function startCreate(event) {
    if (!createMode || !imageData) {
      setSelectedId(null)
      return
    }
    const point = pointerToImage(event)
    const tempId = -Date.now()
    const draft = {
      id: tempId,
      image_id: imageData.image.id,
      category_id: createCategoryId,
      category_name: categoryById[createCategoryId]?.name ?? 'unknown',
      bbox: [point.x, point.y, 1, 1],
      iscrowd: 0,
      ignore: 0,
    }
    setImageData((current) => ({
      ...current,
      annotations: [...current.annotations, draft],
    }))
    setSelectedId(tempId)
    setDirty(true)
    setDragState({
      kind: 'create',
      annotationId: tempId,
      startPoint: point,
    })
  }

  function bulkRelabel() {
    if (!imageData) return
    let touched = 0
    const nextAnnotations = imageData.annotations.map((annotation) => {
      if (annotation.category_id !== Number(bulkFromCategoryId)) return annotation
      touched += 1
      return {
        ...annotation,
        category_id: Number(bulkToCategoryId),
        category_name: categoryById[Number(bulkToCategoryId)]?.name ?? annotation.category_name,
      }
    })
    setImageData((current) => ({ ...current, annotations: nextAnnotations }))
    if (touched > 0) setDirty(true)
    setStatusMessage(
      touched > 0
        ? `Relabeled ${touched} annotations on ${imageData.image.file_name}.`
        : 'No annotations matched the bulk relabel source category.',
    )
  }

  function goRelative(offset) {
    const index = filteredImages.findIndex((image) => image.id === activeImageId)
    if (index < 0) return
    const target = filteredImages[index + offset]
    if (target) loadImage(target.id)
  }

  if (error) {
    return <div className="editor-empty-state">{error}</div>
  }

  if (!meta || !imageData) {
    return <div className="editor-empty-state">Loading editor…</div>
  }

  return (
    <div className="editor-shell">
      <aside className="editor-sidebar glass">
        <div className="editor-sidebar-head">
          <div>
            <div className="editor-kicker">Phase3 dataset</div>
            <h2>Label Editor</h2>
          </div>
          <div className={`editor-dirty-pill ${dirty ? 'is-dirty' : ''}`}>{dirty ? 'Unsaved' : 'Saved'}</div>
        </div>

        <label className="editor-search">
          <span>Search images</span>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="000120"
          />
        </label>

        <div className="editor-sidebar-meta">
          <div>{meta.image_count} images</div>
          <div>{meta.annotation_count} annotations</div>
        </div>

        <div className="editor-image-list">
          {filteredImages.map((image) => (
            <button
              key={image.id}
              className={`editor-image-item ${image.id === activeImageId ? 'is-active' : ''}`}
              onClick={() => loadImage(image.id)}
              type="button"
            >
              <strong>{image.file_name}</strong>
              <span>{image.annotation_count} boxes</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="editor-main">
        <section className="editor-toolbar glass">
          <div className="editor-toolbar-block">
            <button className="btn btn-sm" onClick={() => goRelative(-1)} type="button">Previous</button>
            <button className="btn btn-sm" onClick={() => goRelative(1)} type="button">Next</button>
            <button className={`btn btn-sm ${createMode ? 'btn-primary' : ''}`} onClick={() => setCreateMode((value) => !value)} type="button">
              {createMode ? 'Drawing New Box' : 'New Box'}
            </button>
            <button className="btn btn-sm" onClick={deleteSelected} type="button" disabled={selectedId == null}>Delete</button>
            <button className="btn btn-primary btn-sm" onClick={saveCurrentImage} type="button" disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>

          <div className="editor-toolbar-block">
            <label className="editor-inline-field">
              <span>New box class</span>
              <select value={createCategoryId} onChange={(event) => setCreateCategoryId(Number(event.target.value))}>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <label className="editor-inline-field editor-zoom-field">
              <span>Zoom</span>
              <input type="range" min="0.3" max="2" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
              <strong>{Math.round(zoom * 100)}%</strong>
            </label>
          </div>
        </section>

        <section className="editor-content">
          <div className="editor-canvas-panel glass">
            <div className="editor-canvas-head">
              <div>
                <h3>{imageData.image.file_name}</h3>
                <p>{imageData.image.width} × {imageData.image.height} • {imageData.annotations.length} annotations</p>
              </div>
              <div className="editor-status-copy">{loadingImage ? 'Loading image…' : statusMessage}</div>
            </div>

            <div className="editor-filter-row">
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`editor-filter-chip ${visibleCategories.has(category.id) ? 'is-on' : ''}`}
                  style={{ '--chip-color': CATEGORY_COLORS[category.name] ?? '#94a3b8' }}
                  onClick={() => {
                    setVisibleCategories((current) => {
                      const next = new Set(current)
                      if (next.has(category.id)) next.delete(category.id)
                      else next.add(category.id)
                      return next
                    })
                  }}
                >
                  {category.name} <span>{currentCounts[category.name] ?? 0}</span>
                </button>
              ))}
            </div>

            <div className="editor-stage-scroll">
              <div
                ref={stageRef}
                className={`editor-stage ${createMode ? 'is-create-mode' : ''}`}
                style={{ width: imageData.image.width * zoom, height: imageData.image.height * zoom }}
              >
                <img src={imageData.image.image_url} alt={imageData.image.file_name} draggable="false" />
                <svg
                  viewBox={`0 0 ${imageData.image.width} ${imageData.image.height}`}
                  className="editor-overlay"
                  onPointerDown={startCreate}
                >
                  {visibleAnnotations.map((annotation) => {
                    const [x, y, w, h] = annotation.bbox
                    const color = CATEGORY_COLORS[annotation.category_name] ?? '#e5e7eb'
                    const isSelected = annotation.id === selectedId
                    const handles = bboxHandles(annotation.bbox)
                    return (
                      <g key={annotation.id}>
                        <rect
                          x={x}
                          y={y}
                          width={w}
                          height={h}
                          fill={isSelected ? `${color}22` : 'transparent'}
                          stroke={color}
                          strokeWidth={isSelected ? 3 : 2}
                          onPointerDown={(event) => startMove(annotation.id, event)}
                        />
                        <rect x={x} y={Math.max(0, y - 18)} width={Math.max(84, annotation.category_name.length * 7.5)} height="18" fill={color} />
                        <text x={x + 4} y={Math.max(12, y - 5)} fill="#091018" fontSize="12" fontWeight="700">
                          {annotation.category_name}
                        </text>
                        {isSelected && HANDLE_NAMES.map((handle) => (
                          <circle
                            key={handle}
                            cx={handles[handle][0]}
                            cy={handles[handle][1]}
                            r="5.5"
                            fill="#ffffff"
                            stroke={color}
                            strokeWidth="2"
                            onPointerDown={(event) => startResize(annotation.id, handle, event)}
                          />
                        ))}
                      </g>
                    )
                  })}
                </svg>
              </div>
            </div>
          </div>

          <aside className="editor-inspector glass">
            <div className="editor-panel">
              <h3>Selected Box</h3>
              {selectedAnnotation ? (
                <>
                  <div className="editor-selected-meta">
                    <span>ID {selectedAnnotation.id > 0 ? selectedAnnotation.id : 'new'}</span>
                    <span>{selectedAnnotation.category_name}</span>
                  </div>
                  <label className="editor-stack-field">
                    <span>Category</span>
                    <select
                      value={selectedAnnotation.category_id}
                      onChange={(event) => replaceAnnotation(selectedAnnotation.id, {
                        category_id: Number(event.target.value),
                      })}
                    >
                      {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                  </label>
                  <div className="editor-bbox-grid">
                    {['x', 'y', 'w', 'h'].map((label, index) => (
                      <label key={label} className="editor-stack-field">
                        <span>{label.toUpperCase()}</span>
                        <input
                          type="number"
                          step="0.1"
                          value={selectedAnnotation.bbox[index]}
                          onChange={(event) => updateSelectedBBox(index, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <p className="editor-muted">Select a box to edit its class and exact coordinates.</p>
              )}
            </div>

            <div className="editor-panel">
              <h3>Bulk Relabel Current Image</h3>
              <div className="editor-bulk-grid">
                <label className="editor-stack-field">
                  <span>From</span>
                  <select value={bulkFromCategoryId} onChange={(event) => setBulkFromCategoryId(Number(event.target.value))}>
                    {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </select>
                </label>
                <label className="editor-stack-field">
                  <span>To</span>
                  <select value={bulkToCategoryId} onChange={(event) => setBulkToCategoryId(Number(event.target.value))}>
                    {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </select>
                </label>
              </div>
              <button className="btn btn-sm" type="button" onClick={bulkRelabel}>Apply Bulk Relabel</button>
            </div>

            <div className="editor-panel">
              <h3>Current Image Counts</h3>
              <div className="editor-count-list">
                {categories.map((category) => (
                  <div key={category.id} className="editor-count-item">
                    <span>{category.name}</span>
                    <strong>{currentCounts[category.name] ?? 0}</strong>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}

export default DatasetEditor
