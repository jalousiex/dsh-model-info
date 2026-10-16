// Minimal read-only asar reader + scanner (asar stores files uncompressed).
// usage:
//   node asar.cjs <asar> ls <innerDir>
//   node asar.cjs <asar> read <innerFile> <outFile>
//   node asar.cjs <asar> scan <pathRegex> <contentRegex> [maxBytes] [maxHits]
const fs = require('fs')

const asarPath = process.argv[2]
const mode = process.argv[3]

const fd = fs.openSync(asarPath, 'r')
const hdr = Buffer.alloc(16)
fs.readSync(fd, hdr, 0, 16, 0)
const headerJsonSize = hdr.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerJsonSize)
fs.readSync(fd, headerBuf, 0, headerJsonSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const base = 16 + headerJsonSize

function resolve(parts, node) {
  let cur = node
  for (const p of parts) {
    if (!cur || !cur.files) return null
    cur = cur.files[p]
  }
  return cur || null
}

function readText(inner) {
  let node = resolve(inner.split('/'), header)
  if (node && node.link) node = resolve(node.link.split('/'), header)
  if (!node || !Number.isFinite(Number(node.size)) || !Number.isFinite(Number(node.offset))) return null
  const size = Number(node.size)
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, base + Number(node.offset))
  return buf.toString('utf8')
}

if (mode === 'ls') {
  const node = resolve((process.argv[4] || '').split('/').filter(Boolean), header)
  if (!node) { console.log('NOT FOUND'); process.exit(1) }
  console.log(Object.keys(node.files || {}).join('\n'))
  process.exit(0)
}

if (mode === 'read') {
  const text = readText(process.argv[4])
  if (text === null) { console.log('NOT FOUND'); process.exit(1) }
  fs.writeFileSync(process.argv[5], text)
  console.log('wrote ' + process.argv[5] + ' (' + text.length + ' chars)')
  process.exit(0)
}

if (mode === 'scan') {
  const pathRe = new RegExp(process.argv[4], 'i')
  const re = new RegExp(process.argv[5], 'gi')
  const maxBytes = parseInt(process.argv[6] || '40000000', 10)
  const maxHits = parseInt(process.argv[7] || '8', 10)
  let scanned = 0
  let found = 0
  const out = []
  ;(function visit(node, prefix) {
    if (!node || !node.files) return
    for (const name of Object.keys(node.files)) {
      const child = node.files[name]
      const path = prefix ? prefix + '/' + name : name
      if (child.files) { visit(child, path); continue }
      if (!/\.(js|mjs|cjs)$/i.test(path) || !pathRe.test(path)) continue
      const size = Number(child.size)
      if (child.link || !Number.isFinite(size) || size === 0 || size > maxBytes) continue
      if (!Number.isFinite(Number(child.offset))) continue
      scanned++
      const text = readText(path)
      if (text === null) continue
      const rx = new RegExp(re.source, 'gi')
      let m
      while ((m = rx.exec(text)) !== null && found < maxHits) {
        const start = Math.max(0, m.index - 240)
        const end = Math.min(text.length, m.index + m[0].length + 240)
        out.push('=== ' + path + ' @' + m.index + ' ===\n' + text.slice(start, end))
        found++
        if (m.index === rx.lastIndex) rx.lastIndex++
      }
    }
  })(header, '')
  console.log(out.join('\n\n'))
  console.log(`\nscanned=${scanned} hits=${found}`)
  process.exit(0)
}

console.log('unknown mode')
