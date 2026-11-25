import { z } from 'zod'
import { ApiError } from '../store.ts'

const component = z.object({
  type: z.string(), format: z.string().optional(), text: z.string().optional(),
  buttons: z.array(z.object({type:z.string(), text:z.string().optional(), url:z.string().optional()})).optional(),
})
export const templateCatalog = z.object({templates:z.array(z.object({
  name:z.string(), language:z.string(), status:z.string(), components:z.array(component),
}))})
type Section = {type:'body'|'header'|'footer'|'button'; text:string; keys:string[]; index?:number}
export type FollowupTemplate = {name:string; language:string; sections:Section[]}
export const templateSelection = z.object({
  name:z.string().regex(/^[a-z0-9_]{1,512}$/), language:z.string().regex(/^[A-Za-z_]{2,16}$/),
  values:z.array(z.string().trim().min(1).max(1024)).max(100),
}).strict()

function variables(text:string) {
  const keys = [...new Set(Array.from(text.matchAll(/{{([a-z_0-9]+)}}/g), match=>match[1]!))]
  return keys.every(key=>/^\d+$/.test(key)) ? keys.sort((a,b)=>Number(a)-Number(b)) : keys
}

export function followupTemplates(catalog:z.infer<typeof templateCatalog>) {
  const templates:FollowupTemplate[] = []
  let unsupported = 0
  for (const item of catalog.templates) {
    if (item.status !== 'APPROVED') continue
    const sections:Section[] = []
    let supported = true
    for (const part of item.components) {
      const type = part.type.toLowerCase()
      if (type === 'buttons') {
        for (const [index,button] of (part.buttons ?? []).entries()) {
          const kind = button.type.toUpperCase()
          if (!['URL','QUICK_REPLY','PHONE_NUMBER'].includes(kind)) supported = false
          const text = [button.text,button.url].filter(Boolean).join(' · ')
          sections.push({type:'button',text,keys:variables(button.url ?? ''),index})
        }
      } else if ((type === 'header' && (part.format ?? 'TEXT').toUpperCase() === 'TEXT') || type === 'body' || type === 'footer') {
        const text = part.text ?? ''
        sections.push({type,text,keys:variables(text)})
      } else supported = false
    }
    if (supported && sections.some(s=>s.type==='body' && s.text)) templates.push({name:item.name,language:item.language,sections})
    else unsupported++
  }
  return {templates,unsupported}
}

export function prepareTemplate(catalog:FollowupTemplate[], selection:z.infer<typeof templateSelection>) {
  const template = catalog.find(t=>t.name===selection.name && t.language===selection.language)
  if (!template) throw new ApiError(422,'La plantilla ya no está disponible como aprobada para esta cuenta.')
  if (template.sections.reduce((n,s)=>n+s.keys.length,0)!==selection.values.length) {
    throw new ApiError(422,'Revisá los campos de la plantilla.')
  }
  let offset = 0
  const components = []
  const lines = []
  for (const section of template.sections) {
    const values = selection.values.slice(offset,offset+section.keys.length)
    offset += values.length
    lines.push(section.text.replace(/{{([a-z_0-9]+)}}/g,(token,key)=>values[section.keys.indexOf(key)] ?? token))
    if (values.length) components.push({
      type:section.type, ...(section.type==='button'?{sub_type:'url',index:String(section.index)}:{}),
      parameters:section.keys.map((key,i)=>({type:'text',text:values[i],...(/^\d+$/.test(key)?{}:{parameter_name:key})})),
    })
  }
  const text = lines.filter(Boolean).join('\n')
  if (text.length>10000) throw new ApiError(422,'El contenido de la plantilla es demasiado largo.')
  return {text,template:{name:template.name,language:template.language,components}}
}
