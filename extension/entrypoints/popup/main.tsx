import { render } from "solid-js/web";
import "../../assets/app.css";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Popup root element not found");

render(() => <App />, root);
