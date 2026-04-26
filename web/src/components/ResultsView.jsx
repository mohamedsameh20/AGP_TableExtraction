import ImageViewer from './ImageViewer'
import TableGrid from './TableGrid'
import ConfidenceLegend from './ConfidenceLegend'

const API = ''

export default function ResultsView({ job, onBack }) {
  const { annotation, duration } = job
  const tables = annotation?.tables || []
  const totalCells = tables.reduce((s, t) => s + (t.cells?.length || 0), 0)
  const pageCount = annotation?.page_count || 1

  const handleExport = (format) => {
    window.open(`${API}/api/export/${job.id}?format=${format}`, '_blank')
  }

  const handleDownloadCrops = () => {
    window.open(`${API}/api/table-crops/${job.id}`, '_blank')
  }

  return (
    <div className="results-container">
      <div className="results-header">
        <h2>
          <span style={{ cursor: 'pointer', opacity: 0.6 }} onClick={onBack}>←</span>
          {' '}{job.filename}
          <span className="badge badge-done">Done</span>
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {pageCount > 1 ? `${pageCount} pages • ` : ''}
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
            {tables.length > 0 && (
              <button className="btn btn-sm btn-primary" onClick={handleDownloadCrops}>
                🖼️ Table Crops
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="results-body">
        {/* Left panel — Image with overlays */}
        <div className="results-panel">
          <div className="results-panel-header">
            <h3>🖼️ Image Preview</h3>
            <ConfidenceLegend />
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
            {tables.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {tables.map(t => (
                  <span key={t.table_id} style={{ marginRight: 8 }}>
                    T{t.table_id}: {t.td_score != null ? `${Math.round(t.td_score * 100)}%` : '—'}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="results-panel-body">
            <TableGrid tables={tables} jobId={job.id} />
          </div>
        </div>
      </div>
    </div>
  )
}
