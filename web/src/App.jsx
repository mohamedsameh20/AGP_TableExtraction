import { useCallback, useState } from 'react'
import './index.css'
import UploadView from './components/UploadView'
import ProcessingView from './components/ProcessingView'
import ResultsView from './components/ResultsView'
import HealthDashboard from './components/HealthDashboard'

const API = ''  // same origin

function App() {
  const [tool, setTool] = useState('extractor') // extractor | health
  const [view, setView] = useState('upload') // upload | processing | results
  const [jobs, setJobs] = useState([])
  const [activeJob, setActiveJob] = useState(null)

  const handleUpload = useCallback(async (files) => {
    const newJobs = []
    for (const file of files) {
      const fd = new FormData()
      fd.append('file', file)
      try {
        const res = await fetch(`${API}/api/upload-and-process`, { method: 'POST', body: fd })
        const data = await res.json()
        if (!res.ok) {
          console.error(`Upload failed for ${file.name}:`, data)
          continue
        }
        if (!data?.job_id) {
          console.error(`Upload response missing job_id for ${file.name}:`, data)
          continue
        }
        newJobs.push({
          id: data.job_id,
          filename: data.filename,
          status: 'processing',
          annotation: null,
          duration: null,
          imageUrl: `${API}/api/image/${data.job_id}`,
        })
      } catch (err) {
        console.error('Upload failed:', err)
      }
    }
    if (newJobs.length === 0) {
      return
    }
    setJobs(prev => [...newJobs, ...prev])
    if (newJobs.length === 1) {
      setActiveJob(newJobs[0])
      setView('processing')
      pollJob(newJobs[0].id)
    } else if (newJobs.length > 1) {
      setView('processing')
      newJobs.forEach(j => pollJob(j.id))
    }
  }, [])

  const pollJob = useCallback((jobId) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/status/${jobId}`)
        const data = await res.json()
        if (data.status === 'done') {
          clearInterval(interval)
          const resData = await fetch(`${API}/api/results/${jobId}`)
          const results = await resData.json()
          setJobs(prev => prev.map(j => j.id === jobId ? {
            ...j,
            status: 'done',
            annotation: results.annotation,
            duration: results.duration,
          } : j))
          setActiveJob(prev => {
            if (prev && prev.id === jobId) {
              setView('results')
              return {
                ...prev,
                status: 'done',
                annotation: results.annotation,
                duration: results.duration,
              }
            }
            return prev
          })
        } else if (data.status === 'error') {
          clearInterval(interval)
          setJobs(prev => prev.map(j => j.id === jobId ? {
            ...j, status: 'error', error: data.error
          } : j))
        }
      } catch (err) {
        console.error('Poll error:', err)
      }
    }, 1000)
  }, [])

  const openJob = useCallback((job) => {
    setActiveJob(job)
    if (job.status === 'done') {
      setView('results')
    } else if (job.status === 'processing' || job.status === 'queued') {
      setView('processing')
      pollJob(job.id)
    }
  }, [pollJob])

  const goHome = useCallback(() => {
    setView('upload')
    setActiveJob(null)
  }, [])

  return (
    <div className="app-container">
      <header className="header">
        <div className="header-brand" onClick={() => { setTool('extractor'); goHome() }} style={{ cursor: 'pointer' }}>
          <div className="header-logo">A</div>
          <div>
            <div className="header-title">Ag27</div>
            <div className="header-subtitle">
              {tool === 'health' ? 'System Health' : 'Table Extractor'}
            </div>
          </div>
        </div>
        <nav className="header-nav">
          <button className={`btn btn-sm ${tool === 'extractor' ? 'btn-primary' : ''}`} onClick={() => setTool('extractor')}>
            Extractor
          </button>
          <button className={`btn btn-sm ${tool === 'health' ? 'btn-primary' : ''}`} onClick={() => setTool('health')}>
            📊 Health
          </button>
          {tool === 'extractor' && jobs.filter(j => j.status === 'done').length > 0 && view !== 'upload' && (
            <button className="btn btn-sm" onClick={goHome}>
              ← New Upload
            </button>
          )}
          {tool === 'extractor' && jobs.length > 0 && (
            <button className="btn btn-sm" onClick={() => { setTool('extractor'); setView('upload') }}>
              {jobs.filter(j => j.status === 'done').length} processed
            </button>
          )}
        </nav>
      </header>

      {tool === 'health' ? (
        <HealthDashboard />
      ) : (
        <>
          {view === 'upload' && (
            <UploadView
              onUpload={handleUpload}
              jobs={jobs}
              onOpenJob={openJob}
            />
          )}
          {view === 'processing' && activeJob && (
            <ProcessingView job={activeJob} />
          )}
          {view === 'results' && activeJob && (
            <ResultsView job={activeJob} onBack={goHome} />
          )}
        </>
      )}
    </div>
  )
}

export default App
