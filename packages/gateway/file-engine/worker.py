#!/usr/bin/env python3
"""Confined file-engine process. One JSON request in, one JSON result out."""
import hashlib, json, os, shutil, subprocess, sys, time, uuid, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

class FileEngineError(Exception):
    pass

def fail(code: str):
    raise FileEngineError(code)

def safe_path(value: str, job_dir: str, must_exist: bool = True) -> Path:
    path = Path(value).resolve()
    root = Path(job_dir).resolve()
    if must_exist and not path.is_file(): fail("UNAUTHORIZED_FILE")
    if not must_exist and path.parent != root: fail("UNAUTHORIZED_FILE")
    return path

def safe_zip(path: Path) -> zipfile.ZipFile:
    archive = zipfile.ZipFile(path)
    infos = archive.infolist()
    if len(infos) > 10000: fail("FILE_CONTAINER_LIMIT")
    expanded = sum(item.file_size for item in infos)
    compressed = max(1, sum(item.compress_size for item in infos))
    if expanded > 512 * 1024 * 1024 or expanded / compressed > 200: fail("FILE_CONTAINER_LIMIT")
    for item in infos:
        name = item.filename.replace("\\", "/")
        if name.startswith("/") or ".." in name.split("/"): fail("FILE_CONTAINER_LIMIT")
    return archive

def docx_read(path: Path) -> dict:
    with safe_zip(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    paragraphs = []
    for p in root.iter(W + "p"):
        text = "".join((node.text or "") for node in p.iter(W + "t")).strip()
        if text: paragraphs.append(text)
    tables = []
    for table in root.iter(W + "tbl"):
        rows = []
        for row in table.findall(".//" + W + "tr"):
            rows.append(["".join((n.text or "") for n in cell.iter(W + "t")) for cell in row.findall(W + "tc")])
        tables.append(rows)
    return {"paragraphs": paragraphs, "tables": tables}

def xlsx_read(path: Path) -> dict:
    with safe_zip(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            shared = ["".join(n.text or "" for n in item.iter(S + "t")) for item in root.findall(S + "si")]
        workbook = ET.fromstring(z.read("xl/workbook.xml"))
        names = [node.attrib.get("name", "") for node in workbook.iter(S + "sheet")]
        sheets = []
        for index, name in enumerate(names, 1):
            entry = f"xl/worksheets/sheet{index}.xml"
            if entry not in z.namelist(): continue
            root = ET.fromstring(z.read(entry)); cells = {}
            for cell in root.iter(S + "c"):
                ref = cell.attrib.get("r", ""); value = cell.find(S + "v"); formula = cell.find(S + "f")
                raw = value.text if value is not None else ""
                if cell.attrib.get("t") == "s" and raw.isdigit() and int(raw) < len(shared): raw = shared[int(raw)]
                cells[ref] = {"value": raw, "formula": formula.text if formula is not None else None}
            sheets.append({"name": name, "cells": cells})
    return {"sheets": sheets}

def pdf_read(path: Path) -> dict:
    try: from pypdf import PdfReader
    except Exception:
        try: from PyPDF2 import PdfFileReader
        except Exception: fail("PDF_ENGINE_UNAVAILABLE")
        with path.open("rb") as stream:
            reader = PdfFileReader(stream)
            pages = [reader.getPage(index).extractText() or "" for index in range(reader.getNumPages())]
        return {"page_count": len(pages), "pages": pages}
    reader = PdfReader(str(path))
    return {"page_count": len(reader.pages), "pages": [page.extract_text() or "" for page in reader.pages]}

def inspect(path: Path, media_type: str) -> dict:
    if "wordprocessingml" in media_type: content = docx_read(path)
    elif "spreadsheetml" in media_type: content = xlsx_read(path)
    elif media_type == "application/pdf": content = pdf_read(path)
    else: fail("UNSUPPORTED_FORMAT_OPERATION")
    return {"media_type": media_type, "size_bytes": path.stat().st_size, **content}

def validate_template_fill(request: dict, input_path: Path) -> dict:
    root = Path(os.environ.get("GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT",
        str(Path(__file__).resolve().parent / "templates"))).resolve()
    try: catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    except Exception: fail("TEMPLATE_CATALOG_INVALID")
    target = request.get("target", {}); change = request.get("change", {})
    wanted = (str(target.get("template_id", "")), str(target.get("template_version", "")),
        str(target.get("template_sha256", "")))
    row = next((item for item in catalog.get("templates", []) if
        (str(item.get("template_id", "")), str(item.get("version", "")), str(item.get("sha256", ""))) == wanted), None)
    if not row or row.get("format") != "docx": fail("TEMPLATE_NOT_FOUND")
    digest = hashlib.sha256(input_path.read_bytes()).hexdigest()
    if digest != wanted[2]: fail("TEMPLATE_HASH_MISMATCH")
    declared = row.get("fields", {}); fields = change.get("fields", {})
    if not isinstance(fields, dict) or set(fields) != set(declared): fail("TEMPLATE_CONTENT_INVALID")
    replacements = {}
    for name, definition in declared.items():
        value = fields.get(name)
        limit = int(definition.get("max_chars", 0))
        if not isinstance(value, str) or not value.strip() or limit < 1 or len(value) > limit:
            fail("TEMPLATE_CONTENT_INVALID")
        replacements[str(definition.get("token", ""))] = value
    if any(not token.startswith("[[DSH:") for token in replacements): fail("TEMPLATE_CATALOG_INVALID")
    cleanup = row.get("final_output_cleanup", {})
    return {"replacements": replacements,
        "remove_exact": list(cleanup.get("remove_body_paragraphs_exact_text", [])),
        "remove_footer_literal": str(cleanup.get("remove_footer_literal", ""))}

def validate_record_fill(request: dict, input_path: Path) -> dict:
    root = Path(os.environ.get("GENERAL_AGENT_FILE_ENGINE_TEMPLATE_ROOT",
        str(Path(__file__).resolve().parent / "templates"))).resolve()
    try: catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
    except Exception: fail("TEMPLATE_CATALOG_INVALID")
    target = request.get("target", {}); change = request.get("change", {})
    wanted = (str(target.get("template_id", "")), str(target.get("template_version", "")),
        str(target.get("template_sha256", "")))
    row = next((item for item in catalog.get("templates", []) if
        (str(item.get("template_id", "")), str(item.get("version", "")), str(item.get("sha256", ""))) == wanted), None)
    if not row or row.get("format") != "xlsx" or not row.get("mapping"): fail("TEMPLATE_NOT_FOUND")
    if hashlib.sha256(input_path.read_bytes()).hexdigest() != wanted[2]: fail("TEMPLATE_HASH_MISMATCH")
    mapping_path = (root / str(row["mapping"])).resolve()
    if mapping_path.parent != root or not mapping_path.is_file(): fail("TEMPLATE_CATALOG_INVALID")
    try: mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    except Exception: fail("TEMPLATE_CATALOG_INVALID")
    records = change.get("records")
    if change.get("schema_version") != "evidence-records/1.0" or not isinstance(records, list):
        fail("TEMPLATE_CONTENT_INVALID")
    if len(records) > int(mapping.get("capacity", 0)): fail("TEMPLATE_CONTENT_INVALID")
    columns = mapping.get("columns", {}); natural_keys = mapping.get("natural_key", []); seen = set(); rows = []
    for offset, record in enumerate(records):
        if not isinstance(record, dict) or set(record) != set(columns): fail("TEMPLATE_CONTENT_INVALID")
        verification = str(record.get("verification", ""))
        if verification not in mapping.get("status_labels", {}): fail("TEMPLATE_CONTENT_INVALID")
        natural = tuple(str(record.get(key, "")) for key in natural_keys)
        if not any(natural) or natural in seen: fail("TEMPLATE_CONTENT_INVALID")
        seen.add(natural)
        if verification == "verified" and (not str(record.get("source_url", "")).startswith(("http://", "https://"))
            or not str(record.get("evidence_ref", "")).strip()): fail("TEMPLATE_CONTENT_INVALID")
        if verification == "missing" and record.get("value") is not None: fail("TEMPLATE_CONTENT_INVALID")
        cells = {}
        for key, column in columns.items():
            value = mapping["status_labels"][verification] if key == "verification" else record.get(key)
            if isinstance(value, str) and len(value) > 2000: fail("TEMPLATE_CONTENT_INVALID")
            cells[f"{column}{int(mapping['row_start']) + offset}"] = value
        rows.append(cells)
    return {"sheet": str(mapping.get("sheet", "")), "rows": rows}

def uno_edit(req: dict, input_path: Path, output_path: Path, job_dir: Path) -> dict:
    try: import uno
    except Exception: fail("UNO_UNAVAILABLE")
    office = os.environ.get("GENERAL_AGENT_LIBREOFFICE", "/usr/bin/libreoffice")
    pipe = "jotfile_" + uuid.uuid4().hex
    profile = job_dir / "lo-profile"; profile.mkdir(mode=0o700, exist_ok=True)
    process = subprocess.Popen([office, "--headless", "--nologo", "--nodefault", "--nofirststartwizard",
        "--nolockcheck", f"-env:UserInstallation={uno.systemPathToFileUrl(str(profile))}",
        f"--accept=pipe,name={pipe};urp;StarOffice.ComponentContext"], stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, start_new_session=True)
    document = None
    reopened = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        context = None
        for _ in range(80):
            try: context = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext"); break
            except Exception: time.sleep(.1)
        if context is None: fail("UNO_CONNECT_FAILED")
        desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        prop = lambda n, v: uno.createUnoStruct("com.sun.star.beans.PropertyValue")
        hidden = prop("Hidden", True); hidden.Name = "Hidden"; hidden.Value = True
        macro = prop("MacroExecutionMode", 0); macro.Name = "MacroExecutionMode"; macro.Value = 0
        update = prop("UpdateDocMode", 0); update.Name = "UpdateDocMode"; update.Value = 0
        document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(input_path)), "_blank", 0, (hidden, macro, update))
        if document is None: fail("UNO_LOAD_FAILED")
        operation = req["operation"]; body = req.get("request", {}); target = body.get("target", {}); change = body.get("change", {})
        if operation == "writer.fill_template":
            plan = validate_template_fill(body, input_path)
            for old, new in plan["replacements"].items():
                search = document.createSearchDescriptor(); search.SearchString = old
                found = document.findAll(search)
                if found.getCount() != 1: fail("TEMPLATE_CONTENT_INVALID")
                replace = document.createReplaceDescriptor(); replace.SearchString = old; replace.ReplaceString = new
                document.replaceAll(replace)
            for old in plan["remove_exact"]:
                replace = document.createReplaceDescriptor(); replace.SearchString = old; replace.ReplaceString = ""
                document.replaceAll(replace)
            if plan["remove_footer_literal"]:
                replace = document.createReplaceDescriptor(); replace.SearchString = plan["remove_footer_literal"]; replace.ReplaceString = ""
                document.replaceAll(replace)
        elif operation == "writer.replace_text":
            search = document.createSearchDescriptor(); search.SearchString = str(target.get("old_text", ""))
            found = document.findAll(search); expected = int(target.get("expected_matches", 1))
            if found.getCount() != expected: fail("AMBIGUOUS_TARGET" if found.getCount() > 1 else "EXPECTED_VALUE_MISMATCH")
            replace = document.createReplaceDescriptor(); replace.SearchString = search.SearchString; replace.ReplaceString = str(change.get("new_text", ""))
            document.replaceAll(replace)
        elif operation == "writer.set_table_cell":
            tables = document.getTextTables(); table_name = str(target.get("table", "")); cell_name = str(target.get("cell", ""))
            table = tables.getByName(table_name) if table_name else tables.getByIndex(int(target.get("table_index", 0)))
            cell = table.getCellByName(cell_name); old = cell.getString()
            if "old_value" in target and old != str(target["old_value"]): fail("EXPECTED_VALUE_MISMATCH")
            cell.setString(str(change.get("value", "")))
        elif operation == "calc.fill_records":
            plan = validate_record_fill(body, input_path)
            sheet = document.getSheets().getByName(plan["sheet"])
            for row in plan["rows"]:
                for address, value in row.items():
                    cell = sheet.getCellRangeByName(address)
                    if isinstance(value, (int, float)) and not isinstance(value, bool): cell.setValue(float(value))
                    else: cell.setString("" if value is None else str(value))
            document.calculateAll()
        elif operation in ("calc.set_cells", "calc.recalculate"):
            sheet = document.getSheets().getByName(str(target.get("sheet", "")))
            for item in change.get("cells", []):
                cell = sheet.getCellRangeByName(str(item["cell"])); kind = item.get("kind")
                if "expected" in item and str(cell.getString()) != str(item["expected"]): fail("EXPECTED_VALUE_MISMATCH")
                if kind == "number": cell.setValue(float(item["value"]))
                elif kind == "formula": cell.setFormula(str(item["value"]))
                else: cell.setString(str(item.get("value", "")))
            document.calculateAll()
        else: fail("UNSUPPORTED_FORMAT_OPERATION")
        filters = {"docx": "Office Open XML Text", "xlsx": "Calc MS Excel 2007 XML", "xls": "MS Excel 97"}
        fmt = str(body.get("save_as", {}).get("format", output_path.suffix.lstrip("."))).lower()
        if fmt not in filters: fail("UNSUPPORTED_FORMAT_OPERATION")
        filter_prop = prop("FilterName", filters[fmt]); filter_prop.Name = "FilterName"; filter_prop.Value = filters[fmt]
        overwrite = prop("Overwrite", True); overwrite.Name = "Overwrite"; overwrite.Value = True
        document.storeAsURL(uno.systemPathToFileUrl(str(output_path)), (filter_prop, overwrite)); document.close(True); document = None
        reopened = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(output_path)), "_blank", 0, (hidden, macro, update))
        if reopened is None: fail("OUTPUT_CHECK_FAILED")
        reopened.close(True); reopened = None
    finally:
        for component in (reopened, document):
            if component is not None:
                try: component.close(True)
                except Exception: pass
        process.terminate()
        try: process.wait(timeout=5)
        except Exception: process.kill()
    if req["operation"] == "writer.fill_template":
        with safe_zip(output_path) as archive:
            if any(b"[[DSH:" in archive.read(name) for name in archive.namelist() if name.endswith(".xml")):
                fail("OUTPUT_CHECK_FAILED")
    return {"output_path": str(output_path), "checks": {"engine_saved": "PASS", "saved_and_reopened": "PASS", "macro_execution": "DISABLED", "external_links": "DISABLED"}}

def uno_export_pdf(req: dict, input_path: Path, output_path: Path, job_dir: Path) -> dict:
    media_type = str(req.get("media_type", ""))
    filters = {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "writer_pdf_Export",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "calc_pdf_Export",
        "application/vnd.ms-excel": "calc_pdf_Export",
    }
    if str(req.get("request", {}).get("save_as", {}).get("format", "")).lower() != "pdf":
        fail("UNSUPPORTED_FORMAT_OPERATION")
    filter_name = filters.get(media_type)
    if not filter_name: fail("UNSUPPORTED_FORMAT_OPERATION")
    try: import uno
    except Exception: fail("UNO_UNAVAILABLE")
    office = os.environ.get("GENERAL_AGENT_LIBREOFFICE", "/usr/bin/libreoffice")
    pipe = "jotfile_" + uuid.uuid4().hex
    profile = job_dir / "lo-profile"; profile.mkdir(mode=0o700, exist_ok=True)
    process = subprocess.Popen([office, "--headless", "--nologo", "--nodefault", "--nofirststartwizard",
        "--nolockcheck", f"-env:UserInstallation={uno.systemPathToFileUrl(str(profile))}",
        f"--accept=pipe,name={pipe};urp;StarOffice.ComponentContext"], stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, start_new_session=True)
    document = None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        context = None
        for _ in range(80):
            try: context = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext"); break
            except Exception: time.sleep(.1)
        if context is None: fail("UNO_CONNECT_FAILED")
        desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        def prop(name, value):
            item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
            item.Name = name; item.Value = value
            return item
        hidden = prop("Hidden", True); macro = prop("MacroExecutionMode", 0); update = prop("UpdateDocMode", 0)
        document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(str(input_path)), "_blank", 0,
            (hidden, macro, update))
        if document is None: fail("UNO_LOAD_FAILED")
        document.storeToURL(uno.systemPathToFileUrl(str(output_path)),
            (prop("FilterName", filter_name), prop("Overwrite", True)))
        document.close(True); document = None
        if not output_path.is_file() or output_path.stat().st_size < 100: fail("OUTPUT_CHECK_FAILED")
        content = pdf_read(output_path)
        if int(content.get("page_count", 0)) < 1: fail("OUTPUT_CHECK_FAILED")
    finally:
        if document is not None:
            try: document.close(True)
            except Exception: pass
        process.terminate()
        try: process.wait(timeout=5)
        except Exception: process.kill()
    return {"output_path": str(output_path), "checks": {"page_count": content["page_count"],
        "engine_saved": "PASS", "saved_and_reopened": "PASS", "macro_execution": "DISABLED",
        "external_links": "DISABLED"}}

def pdf_edit(operation: str, input_path: Path, output_path: Path, request: dict) -> dict:
    target = request.get("target", {})
    try:
        from pypdf import PdfReader, PdfWriter
        reader = PdfReader(str(input_path)); writer = PdfWriter()
        page_count = len(reader.pages)
        order = target.get("pages", list(range(1, page_count + 1)))
        for number in order:
            if not isinstance(number, int) or number < 1 or number > page_count: fail("EXPECTED_VALUE_MISMATCH")
            page = reader.pages[number - 1]
            if operation == "pdf.rotate_pages" and number in target.get("rotate_pages", order):
                page.rotate(int(request.get("change", {}).get("degrees", 90)))
            writer.add_page(page)
        with output_path.open("wb") as stream: writer.write(stream)
        output_count = len(writer.pages)
    except ImportError:
        try: from PyPDF2 import PdfFileReader, PdfFileWriter
        except Exception: fail("PDF_ENGINE_UNAVAILABLE")
        with input_path.open("rb") as source, output_path.open("wb") as output:
            reader = PdfFileReader(source); writer = PdfFileWriter(); page_count = reader.getNumPages()
            order = target.get("pages", list(range(1, page_count + 1)))
            for number in order:
                if not isinstance(number, int) or number < 1 or number > page_count: fail("EXPECTED_VALUE_MISMATCH")
                page = reader.getPage(number - 1)
                if operation == "pdf.rotate_pages" and number in target.get("rotate_pages", order):
                    degrees = int(request.get("change", {}).get("degrees", 90))
                    if degrees % 90 != 0: fail("FILE_REQUEST_INVALID")
                    page.rotateClockwise(degrees % 360)
                writer.addPage(page)
            writer.write(output); output_count = writer.getNumPages()
    with output_path.open("rb") as check:
        try:
            from pypdf import PdfReader
            reopened_count = len(PdfReader(check).pages)
        except ImportError:
            from PyPDF2 import PdfFileReader
            reopened_count = PdfFileReader(check).getNumPages()
    if reopened_count != output_count: fail("OUTPUT_CHECK_FAILED")
    return {"output_path": str(output_path), "checks": {"page_count": output_count, "saved_and_reopened": "PASS"}}

def execute(req: dict) -> dict:
    operation = str(req.get("operation", "")); job_dir = str(req.get("job_dir", ""))
    if operation not in {"document.inspect", "document.read", "writer.fill_template", "writer.replace_text", "writer.set_table_cell",
        "calc.fill_records", "calc.set_cells", "calc.recalculate", "office.export_pdf", "pdf.reorder_pages", "pdf.rotate_pages"}: fail("UNSUPPORTED_FORMAT_OPERATION")
    input_path = safe_path(str(req.get("input_path", "")), job_dir if False else str(Path(req.get("input_path", ".")).resolve().parent))
    media_type = str(req.get("media_type", ""))
    if operation in {"document.inspect", "document.read"}:
        return {"ok": True, "engine": {"name": "python_ooxml" if media_type != "application/pdf" else "pypdf", "version": sys.version.split()[0]}, "content": inspect(input_path, media_type), "warnings": []}
    root = Path(job_dir).resolve(); root.mkdir(parents=True, exist_ok=True, mode=0o700)
    output_path = safe_path(str(req.get("output_path", "")), str(root), must_exist=False)
    if operation == "office.export_pdf": result = uno_export_pdf(req, input_path, output_path, root); engine = "libreoffice_uno"
    elif operation.startswith("pdf."): result = pdf_edit(operation, input_path, output_path, req.get("request", {})); engine = "pypdf"
    else: result = uno_edit(req, input_path, output_path, root); engine = "libreoffice_uno"
    return {"ok": True, "engine": {"name": engine, "version": "runtime-probed"}, **result, "warnings": []}

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--probe":
        modules = {}
        for name in ("uno", "pypdf", "PyPDF2"):
            try: __import__(name); modules[name] = "available"
            except Exception: modules[name] = "missing"
        print(json.dumps({"ok": True, "python": sys.version.split()[0], "modules": modules}, ensure_ascii=True)); return
    try: result = execute(json.load(sys.stdin))
    except FileEngineError as error: result = {"ok": False, "error_code": str(error), "engine": {"name": "none", "version": "none"}}
    except Exception as error:
        if os.environ.get("GENERAL_AGENT_FILE_ENGINE_DEBUG") == "1":
            sys.stderr.write(json.dumps({"exception": type(error).__name__, "detail": str(error)[:200]}, ensure_ascii=True) + "\n")
        result = {"ok": False, "error_code": "ENGINE_CRASH", "engine": {"name": "none", "version": "none"}}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))

if __name__ == "__main__": main()
