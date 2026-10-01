"""Generate a neutral original OOXML template; no personal or deployment metadata."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1] / 'file-engine' / 'templates'
root.mkdir(parents=True, exist_ok=True)
path = root / 'report.docx'
fields = ['report_title', 'summary', 'findings', 'recommendation', 'sources']
document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join('<w:p><w:r><w:t>[[DSH:' + field + ']]</w:t></w:r></w:p>' for field in fields) + '<w:sectPr/></w:body></w:document>'
with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    archive.writestr('word/document.xml', document)
catalog = {'catalog_version': '1.0.0', 'templates': [{'template_id': 'report-v1', 'version': '1.0.0', 'format': 'docx', 'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'fields': {field: {'token': '[[DSH:' + field + ']]', 'max_chars': 6000} for field in fields}}]}
(root / 'catalog.json').write_text(json.dumps(catalog, indent=2), encoding='utf-8')
print('Generated neutral report template')
