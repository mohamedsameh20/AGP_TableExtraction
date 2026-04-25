import { useState } from 'react'
import ImageViewer from './ImageViewer'
import TableGrid from './TableGrid'

const API = ''

export default function ResultsView({ job, onBack }) {
  const { annotation, duration, filename } = job
  const tables = annotation?.tables || []
  const totalCells = tables.reduce((s, t) => s + (t.cells?.length || 0), 0)

  const handleExport = (format) => {
    window.open(`${API}/api/export/${job.id}?format=${format}`, '_blank')
  }

  return (
    <div className="results-container">
      <div className="results-header">
        <h2>
          <span style={{ cursor: 'pointer', opacity: 0.6 }} onClick={onBack}>←</span>
          {' '}{filename}
          <span className="badge badge-done">Done</span>
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {tables.length} table{tables.length !== 1 ? 's' : ''} • {totalCells} cells • {duration}s
          </span>
          <div className="export-toolbar">
            <button className="btn btn-sm" onClick={() => handleExport('json')}>
              📋 JSON
            </button>
            <button className="btn btn-sm" onClick={() => handleExport('html')}>
              🌐 HTML
            </button>
            <button className="btn btn-sm" onClick={() => handleExport('csv')}>
              📊 CSV
            </button>
            <button className="btn btn-sm" onClick={() => handleExport('xlsx')}>
              📗 Excel
            </button>
          </div>
        </div>
      </div>

      <div className="results-body">
        {/* Left panel — Image with overlays */}
        <div className="results-panel">
          <div className="results-panel-header">
            <h3>🖼️ Image Preview</h3>
          </div>
          <div className="results-panel-body">
            <ImageViewer
              imageUrl={job.imageUrl}
              tables={tables}
            />
          </div>
        </div>

        {/* Right panel — Table data */}
        <div className="results-panel">
          <div className="results-panel-header">
            <h3>📊 Extracted Tables</h3>
          </div>
          <div className="results-panel-body">
            <TableGrid tables={tables} />
          </div>
        </div>
      </div>
    </div>
  )
}
