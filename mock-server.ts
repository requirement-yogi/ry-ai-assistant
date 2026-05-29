import http from "http"
import fs from "fs"
import path from "path"

const PORT = 3000
const OUTPUT_DIR = "./output"

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR)
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/requirements") {
    let body = ""

    req.on("data", (chunk) => {
      body += chunk.toString()
    })

    req.on("end", () => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const filename = path.join(OUTPUT_DIR, `requirements-${timestamp}.md`)

      fs.writeFileSync(filename, body, "utf-8")
      console.log(`✅ Fichier créé : ${filename}`)

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ success: true, file: filename }))
    })
  } else {
    res.writeHead(404)
    res.end("Not found")
  }
})

server.listen(PORT, () => {
  console.log(`🚀 Mock API server démarré sur http://localhost:${PORT}`)
  console.log(`📁 Les fichiers MD seront sauvegardés dans ${OUTPUT_DIR}/`)
})
