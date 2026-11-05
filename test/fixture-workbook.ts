import { zipSync, strToU8 } from 'fflate'

export function fixtureWorkbook() {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="Resumen" sheetId="1" r:id="rId1"/><sheet name="Contactos" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${ns}"><dimension ref="A1:A2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Resumen</t></is></c></row><row r="2"><c r="A2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${ns}"><dimension ref="A1:C5"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Base de prueba sintética</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Nombre</t></is></c><c r="B2" t="inlineStr"><is><t>Teléfono</t></is></c><c r="C2" t="inlineStr"><is><t>Empresa</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Contacto XLSX</t></is></c><c r="B3" t="inlineStr"><is><t>+54 9 381 3333333</t></is></c><c r="C3" t="inlineStr"><is><t>Koi</t></is></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>Otro XLSX</t></is></c><c r="B5"><v>5493814444444</v></c></row></sheetData></worksheet>`,
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key,value]) => [key,strToU8(value)]))))
}
