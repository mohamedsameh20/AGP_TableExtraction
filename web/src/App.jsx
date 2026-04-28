import { useCallback, useEffect, useRef, useState } from 'react'
import './index.css'
import UploadView from './components/UploadView'
import ProcessingView from './components/ProcessingView'
import ResultsView from './components/ResultsView'
import HealthDashboard from './components/HealthDashboard'
import LandingPage from './components/LandingPage'

const API = ''

export default function App() {
  const [showLanding, setShowLanding] = useState(() => !sessionStorage.getItem('landingSeen'))
  const [tool, setTool] = useState('extractor')
  const [view, setView] = useState('upload')
  const [jobs, setJobs] = useState([])
  const [activeJob, setActiveJob] = useState(null)
  const pollersRef = useRef(new Map())

  const updateJob = useCallback((jobId, updates) => {
    setJobs((currentJobs) => currentJobs.map((job) => (
      job.id === jobId ? { ...job, ...updates } : job
    )))
    setActiveJob((currentJob) => (
      currentJob?.id === jobId ? { ...currentJob, ...updates } : currentJob
    ))
  }, [])

  const stopPolling = useCallback((jobId) => {
    const poller = pollersRef.current.get(jobId)
    if (poller) {
      window.clearInterval(poller)
      pollersRef.current.delete(jobId)
    }
  }, [])

  const pollJob = useCallback((jobId) => {
    if (pollersRef.current.has(jobId)) {
      return
    }

    const interval = window.setInterval(async () => {
      try {
        const statusResponse = await fetch(`${API}/api/status/${jobId}`)
        const statusData = await statusResponse.json()

        if (statusData.status === 'done') {
          stopPolling(jobId)
          const resultsResponse = await fetch(`${API}/api/results/${jobId}`)
          const resultsData = await resultsResponse.json()
          updateJob(jobId, {
            status: 'done',
            annotation: resultsData.annotation,
            duration: resultsData.duration,
          })
          setActiveJob((currentJob) => {
            if (currentJob?.id === jobId) {
              setView('results')
              return {
                ...currentJob,
                status: 'done',
                annotation: resultsData.annotation,
                duration: resultsData.duration,
              }
            }
            return currentJob
          })
        } else if (statusData.status === 'error') {
          stopPolling(jobId)
          updateJob(jobId, {
            status: 'error',
            error: statusData.error,
          })
        }
      } catch (error) {
        console.error('Polling failed', error)
      }
    }, 1000)

    pollersRef.current.set(jobId, interval)
  }, [stopPolling, updateJob])

  useEffect(() => () => {
    for (const poller of pollersRef.current.values()) {
      window.clearInterval(poller)
    }
    pollersRef.current.clear()
  }, [])

  const handleUpload = useCallback(async (files) => {
    const newJobs = []

    for (const file of files) {
      const formData = new FormData()
      formData.append('file', file)

      try {
        const response = await fetch(`${API}/api/upload-and-process`, {
          method: 'POST',
          body: formData,
        })
        const data = await response.json()
        if (!response.ok || !data?.job_id) {
          console.error('Upload failed', data)
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
      } catch (error) {
        console.error('Upload failed', error)
      }
    }

    if (!newJobs.length) {
      return
    }

    setJobs((currentJobs) => [...newJobs, ...currentJobs])
    setActiveJob(newJobs[0])
    setView('processing')
    newJobs.forEach((job) => pollJob(job.id))
  }, [pollJob])

  const handleOpenJob = useCallback((job) => {
    setTool('extractor')
    setActiveJob(job)
    if (job.status === 'done') {
      setView('results')
      return
    }
    setView('processing')
    pollJob(job.id)
  }, [pollJob])

  const handleGoHome = useCallback(() => {
    setView('upload')
    setActiveJob(null)
  }, [])

  const handleDismissLanding = useCallback(() => {
    sessionStorage.setItem('landingSeen', '1')
    setShowLanding(false)
  }, [])

  const showStudio = tool === 'extractor' && view === 'results' && activeJob
  const processedCount = jobs.filter((job) => job.status === 'done').length

  return (
    <>
      {showLanding && <LandingPage onDismiss={handleDismissLanding} />}
      <div className={`app-shell${showStudio ? ' is-studio' : ''}`}>
      {!showStudio && (
        <header className="app-header">
          <button
            type="button"
            className="app-brand"
            onClick={() => {
              setTool('extractor')
              handleGoHome()
            }}
          >
            <div className="app-brand-mark">
              <svg 
                className="fedora-boomerang" 
                viewBox="0 0 24 24" 
                width="24" 
                height="24" 
                fill="currentColor"
              >
                <path d="M2,16C2,16 5,14 12,14C19,14 22,16 22,16V17H2V16M12,5C8,5 6,8 6,10H18C18,8 16,5 12,5Z" />
              </svg>
            </div>
            <span className="app-brand-copy">
              <strong>Agent P-DF</strong>
              <small>AI Table Extraction Studio</small>
            </span>
          </button>

          <nav className="app-header-nav">
            <button
              type="button"
              className={`btn btn-sm${tool === 'extractor' ? ' btn-primary' : ''}`}
              onClick={() => setTool('extractor')}
            >
              Extractor
            </button>
            <button
              type="button"
              className={`btn btn-sm${tool === 'health' ? ' btn-primary' : ''}`}
              onClick={() => setTool('health')}
            >
              System Health
            </button>
            {tool === 'extractor' && view !== 'upload' && (
              <button type="button" className="btn btn-sm" onClick={handleGoHome}>
                New Upload
              </button>
            )}
            {processedCount > 0 && (
              <button type="button" className="btn btn-sm btn-ghost">
                {processedCount} processed
              </button>
            )}
          </nav>
        </header>
      )}

      {tool === 'health' ? (
        <HealthDashboard />
      ) : (
        <>
          {view === 'upload' && (
            <UploadView
              onUpload={handleUpload}
              jobs={jobs}
              onOpenJob={handleOpenJob}
            />
          )}

          {view === 'processing' && activeJob && (
            <ProcessingView job={activeJob} onBack={handleGoHome} />
          )}

          {view === 'results' && activeJob && (
            <ResultsView
              job={activeJob}
              onBack={handleGoHome}
              onJobUpdate={updateJob}
            />
          )}
        </>
      )}
    </div>
    </>
  )
}
