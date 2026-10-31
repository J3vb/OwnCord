import { adminPanelHtml } from "./admin-panel";

export const ADMIN_HTML_SOURCE = adminPanelHtml();

if (!ADMIN_HTML_SOURCE.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
