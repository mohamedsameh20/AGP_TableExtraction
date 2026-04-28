/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, useReducer } from 'react'

function getDefaultActiveTable(annotation, activePage) {
  const tables = annotation?.tables || []
  const first = tables.find((table) => (table.page || 0) === activePage)
  return first?.table_id ?? null
}

function buildInitialState(annotation) {
  const activePage = 0
  return {
    activePage,
    activeCell: null,
    activeTable: getDefaultActiveTable(annotation, activePage),
    tdThreshold: 0,
    showTableGrid: true,
    showTextBoxes: false,
    showHeatmap: false,
    toast: null,
    errorCount: 0,
    undoStack: [],
    redoStack: [],
    activeTool: 'pointer',
    selection: null,
    cellSelection: null,
  }
}

function studioReducer(state, action) {
  switch (action.type) {
    case 'setActivePage':
      return {
        ...state,
        activePage: action.page,
      }
    case 'setActiveTable':
      return {
        ...state,
        activeTable: action.tableId,
      }
    case 'setActiveCell':
      return {
        ...state,
        activeCell: action.cell,
      }
    case 'setThreshold':
      return {
        ...state,
        tdThreshold: action.value,
      }
    case 'toggleFlag':
      return {
        ...state,
        [action.flag]: !state[action.flag],
      }
    case 'showToast':
      return {
        ...state,
        toast: action.toast,
      }
    case 'clearToast':
      return {
        ...state,
        toast: null,
      }
    case 'incrementErrors':
      return {
        ...state,
        errorCount: state.errorCount + 1,
      }
    case 'recordEdit':
      return {
        ...state,
        undoStack: [...state.undoStack, action.edit],
        redoStack: [],
      }
    case 'completeUndo':
      if (!state.undoStack.length) {
        return state
      }
      return {
        ...state,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, state.undoStack[state.undoStack.length - 1]],
      }
    case 'completeRedo':
      if (!state.redoStack.length) {
        return state
      }
      return {
        ...state,
        undoStack: [...state.undoStack, state.redoStack[state.redoStack.length - 1]],
        redoStack: state.redoStack.slice(0, -1),
      }
    case 'setTool':
      return {
        ...state,
        activeTool: action.tool,
        selection: null,
      }
    case 'setSelection':
      return {
        ...state,
        selection: action.selection,
      }
    case 'setCellSelection':
      return {
        ...state,
        cellSelection: action.selection,
      }
    default:
      return state
  }
}

const StudioContext = createContext(null)

export function StudioProvider({ annotation, children }) {
  const [state, dispatch] = useReducer(studioReducer, annotation, buildInitialState)
  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>
}

export function useStudio() {
  const value = useContext(StudioContext)
  if (!value) {
    throw new Error('useStudio must be used within StudioProvider')
  }
  return value
}
