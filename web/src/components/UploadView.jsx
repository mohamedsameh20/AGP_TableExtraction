import { useState, useRef, useCallback } from 'react'

export default function UploadView({ onUpload, jobs, onOpenJob }) {
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef()

  const handleFiles = useCallback((files) => {
    const accepted = Array.from(files).filter(f =>
      /\.(jpe?g|png|bmp|tiff?|pdf)$/i.test(f.name)
    )
    if (accepted.length > 0) onUpload(accepted)
  }, [onUpload])

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    handleFiles(e.dataTransfer.files)
  }, [handleFiles])

  const doneJobs = jobs.filter(j => j.status === 'done')

  return (
    <>
      <section className="upload-section">
        <div className="upload-hero">
          <h1>
            Extract Tables with <span className="gradient-text">AI Precision</span>
          </h1>
          <p>
            Upload document images or PDFs and let our 5-phase pipeline detect tables,
            recognize structure, perform OCR, and extract editable data — all in seconds.
          </p>
        </div>

        <div
          className={`upload-zone glass${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
        >
          <div className="upload-zone-icon">📄</div>
          <h3>Drop files here or click to browse</h3>
          <p>Supports JPG, PNG, BMP, TIFF, and PDF — batch upload enabled</p>
          <input
            ref={fileRef}
            type="file"
            accept=".jpg,.jpeg,.png,.bmp,.tiff,.tif,.pdf"
            multiple
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        <div className="pipeline-steps">
          {[
            ['1', 'Table Detection'],
            ['2', 'Structure Recognition'],
            ['3', 'Text Detection'],
            ['4', 'OCR Recognition'],
            ['5', 'Cell Assignment'],
          ].map(([n, label]) => (
            <div className="pipeline-step" key={n}>
              <span className="step-num">{n}</span>
              {label}
            </div>
          ))}
        </div>
      </section>

      {doneJobs.length > 0 && (
        <section className="jobs-section">
          <div className="jobs-header">
            <h2>Processed Files</h2>
            <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              {doneJobs.length} file{doneJobs.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="jobs-grid">
            {doneJobs.map(job => (
              <div key={job.id} className="job-card" onClick={() => onOpenJob(job)}>
                <img
                  className="job-card-thumb"
                  src={job.imageUrl}
                  alt={job.filename}
                  loading="lazy"
                />
                <div className="job-card-body">
                  <div>
                    <div className="job-card-name">{job.filename}</div>
                    <div className="job-card-meta">
                      {job.annotation?.tables?.length || 0} table(s) • {job.duration}s
                    </div>
                  </div>
                  <span className="badge badge-done">Done</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
