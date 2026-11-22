import { render } from "solid-js/web";
import "../../assets/app.css";
import "../../gallery/gallery.css";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Gallery root element not found");

render(() => <App />, root);
