import { createRoot } from "react-dom/client"
import { AuthenticatedApp } from "./components/AuthenticatedApp"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")
createRoot(root).render(<AuthenticatedApp />)
