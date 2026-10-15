"""Generate a neutral original OOXML template; no personal or deployment metadata."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED


def write_part(archive, name, content):
    """Keep neutral source templates byte-stable across rebuilds."""
    part = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    part.create_system = 3
    part.external_attr = 0o600 << 16
    part.compress_type = ZIP_DEFLATED
    archive.writestr(part, content, compresslevel=9)

root = Path(__file__).resolve().parents[1] / 'file-engine' / 'templates'
root.mkdir(parents=True, exist_ok=True)
path = root / 'technical-report-v1.docx'
fields = ['report_title', 'subtitle', 'date', 'summary', 'scope', 'findings', 'recommendation', 'limitations', 'sources']
document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join('<w:p><w:r><w:t>[[DSH:' + field + ']]</w:t></w:r></w:p>' for field in fields) + '<w:sectPr/></w:body></w:document>'
with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
    write_part(archive, '[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    write_part(archive, '_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    write_part(archive, 'word/document.xml', document)
catalog = {'catalog_version': '1.0.0', 'templates': [{'template_id': 'technical-report-v1', 'version': '1.0.0', 'format': 'docx', 'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'fields': {field: {'token': '[[DSH:' + field + ']]', 'max_chars': 6000} for field in fields}}]}
path = root / 'copy-brief-v1.docx'
fields = ['title', 'date', 'audience_channel', 'facts', 'message', 'draft', 'sources', 'limitations']
document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join('<w:p><w:r><w:t>[[DSH:' + field + ']]</w:t></w:r></w:p>' for field in fields) + '<w:sectPr/></w:body></w:document>'
with ZipFile(root / 'technical-report-v1.docx') as original:
    parts = {name: original.read(name) for name in original.namelist()}
parts['word/document.xml'] = document.encode('utf-8')
with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
    for name, content in parts.items():
        write_part(archive, name, content)
catalog['templates'].append({'template_id':'copy-brief-v1','version':'1.0.0','format':'docx','file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'fields':{field:{'token':'[[DSH:'+field+']]','max_chars':6000} for field in fields}})
columns = dict(zip(['entity_id','metric','value','unit','period','source_url','observed_at','evidence_ref','verification','note'], 'ABCDEFGHIJ'))
mapping = {'template_id':'evidence-table-v1','sheet':'Evidence','header_row':5,'row_start':6,'row_end':25,'capacity':20,'natural_key':['entity_id','metric','period'],'columns':columns,'duplicate_key_policy':'reject','literal_text_policy':'never_convert_untrusted_text_to_formula'}
mapping['status_labels'] = {'verified':'Verified','partial':'Partial','missing':'Missing','synthetic':'Synthetic'}
(root / 'evidence-table-v1.mapping.json').write_text(json.dumps(mapping, indent=2), encoding='utf-8', newline='\n')
path = root / 'evidence-table-v1.xlsx'
office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
rels = 'http://schemas.openxmlformats.org/package/2006/relationships'
headers = ''.join('<c r="'+column+'5" t="inlineStr"><is><t>'+name+'</t></is></c>' for name,column in columns.items())
with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
    write_part(archive, '[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
    write_part(archive, '_rels/.rels', f'<Relationships xmlns="{rels}"><Relationship Id="rId1" Type="{office}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    write_part(archive, 'xl/workbook.xml', f'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="{office}"><sheets><sheet name="Evidence" sheetId="1" r:id="rId1"/></sheets></workbook>')
    write_part(archive, 'xl/_rels/workbook.xml.rels', f'<Relationships xmlns="{rels}"><Relationship Id="rId1" Type="{office}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
    write_part(archive, 'xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="5">'+headers+'</row></sheetData></worksheet>')
catalog['templates'].append({'template_id':'evidence-table-v1','version':'1.0.0','format':'xlsx','file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'fields':{},'mapping':'evidence-table-v1.mapping.json'})
(root / 'catalog.json').write_text(json.dumps(catalog, indent=2), encoding='utf-8', newline='\n')
print('Generated three neutral templates')
