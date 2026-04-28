import { useEffect, useState, useCallback } from 'react'

const API = ''

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h}h ${m}m ${s}s`
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`health-stat-card ${accent || ''}`}>
      <div className="health-stat-value">{value}</div>
      <div className="health-stat-label">{label}</div>
      {sub && <div className="health-stat-sub">{sub}</div>}
    </div>
  )
}

function DonutChart({ success, failure, total }) {
  const pct = total > 0 ? (success / total) * 100 : 0
  const circumference = 2 * Math.PI * 42
  const successLen = (pct / 100) * circumference
  const failLen = circumference - successLen

  return (
    <div className="health-donut-wrap">
      <svg viewBox="0 0 100 100" className="health-donut">
        <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" strokeWidth="8" />
        {total > 0 && (
          <>
            <circle
              cx="50" cy="50" r="42" fill="none"
              stroke="var(--success)" strokeWidth="8"
              strokeDasharray={`${successLen} ${failLen}`}
              strokeDashoffset={circumference / 4}
              strokeLinecap="round"
            />
            {failure > 0 && (
              <circle
                cx="50" cy="50" r="42" fill="none"
                stroke="var(--error)" strokeWidth="8"
                strokeDasharray={`${failLen} ${successLen}`}
                strokeDashoffset={circumference / 4 - successLen}
                strokeLinecap="round"
              />
            )}
          </>
        )}
        <text x="50" y="46" textAnchor="middle" fill="var(--text-primary)" fontSize="16" fontWeight="700">
          {total > 0 ? `${Math.round(pct)}%` : '—'}
        </text>
        <text x="50" y="60" textAnchor="middle" fill="var(--text-muted)" fontSize="8">
          success rate
        </text>
      </svg>
    </div>
  )
}

export default function HealthDashboard() {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/health`)
      if (res.ok) {
        setHealth(await res.json())
      }
    } catch (err) {
      console.error('Health fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const interval = setInterval(fetchHealth, 5000)
    return () => clearInterval(interval)
  }, [fetchHealth])

  if (loading && !health) {
    return (
      <div className="health-dashboard">
        <div className="health-loading">Loading health metrics...</div>
      </div>
    )
  }

  if (!health) {
    return (
      <div className="health-dashboard">
        <div className="health-loading">Unable to reach health endpoint</div>
      </div>
    )
  }

  const { uptime_seconds, total_jobs, successful_jobs, failed_jobs, success_rate, latency, recent_errors, active_jobs } = health

  return (
    <div className="health-dashboard">
      <div className="health-header">
        <h2>📊 System Health</h2>
        <div className="health-uptime">
          <span className="health-status-dot online" />
          Uptime: {formatUptime(uptime_seconds)}
        </div>
      </div>

      <div className="health-grid">
        {/* Donut */}
        <div className="health-card health-card-donut glass">
          <h3>Success Rate</h3>
          <DonutChart success={successful_jobs} failure={failed_jobs} total={total_jobs} />
          <div className="health-donut-legend">
            <span><span className="health-dot success" /> {successful_jobs} succeeded</span>
            <span><span className="health-dot error" /> {failed_jobs} failed</span>
          </div>
        </div>

        {/* Stats */}
        <div className="health-card glass">
          <h3>Overview</h3>
          <div className="health-stats-grid">
            <StatCard label="Total Jobs" value={total_jobs} />
            <StatCard label="Active" value={active_jobs} accent="accent" />
            <StatCard label="Success Rate" value={`${success_rate}%`} accent="success" />
            <StatCard label="Failure Rate" value={`${health.failure_rate}%`} accent={failed_jobs > 0 ? 'error' : ''} />
          </div>
        </div>

        {/* Latency */}
        <div className="health-card glass">
          <h3>Latency (seconds)</h3>
          {latency && latency.avg !== undefined ? (
            <div className="health-stats-grid">
              <StatCard label="Average" value={latency.avg} />
              <StatCard label="Median (p50)" value={latency.p50} />
              <StatCard label="p95" value={latency.p95} />
              <StatCard label="Min / Max" value={`${latency.min} / ${latency.max}`} />
            </div>
          ) : (
            <div className="health-empty">No data yet — process an image to see latency stats.</div>
          )}
        </div>

        {/* Errors */}
        <div className="health-card health-card-errors glass">
          <h3>Recent Errors</h3>
          {recent_errors.length > 0 ? (
            <div className="health-error-list">
              {recent_errors.slice().reverse().map((err, i) => (
                <div key={i} className="health-error-item">
                  <span className="health-error-job">{err.job_id}</span>
                  <span className="health-error-msg">{err.error}</span>
                  <span className="health-error-time">
                    {new Date(err.timestamp * 1000).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="health-empty">No errors recorded ✓</div>
          )}
        </div>
      </div>
    </div>
  )
}
