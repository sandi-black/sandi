import { createRoot } from "react-dom/client";

import "highlight.js/styles/tokyo-night-dark.css";
import "./chat.css";

import { ChatApp } from "./ChatApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ChatApp />);
}
