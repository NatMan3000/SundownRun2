import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './boot'
import './styles.css'

boot()
createRoot(document.getElementById('root')!).render(<App />)
