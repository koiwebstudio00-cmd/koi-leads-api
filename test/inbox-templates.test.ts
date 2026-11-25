import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createZernioClient} from '../src/inbox/provider.ts'
import {prepareTemplate} from '../src/inbox/templates.ts'

test('approved catalog is account-scoped and prepares only the selected variant and its parameters',async()=>{
  const base={name:'seguimiento',language:'es_AR',status:'APPROVED'}
  const live={...base,components:[
    {type:'BODY',text:'Hola {{nombre}}, confirmamos {{pedido}}.'},
    {type:'BUTTONS',buttons:[{type:'URL',text:'Ver pedido',url:'https://example.test/{{1}}'}]},
  ]}
  const provider=createZernioClient('fixture',async url=>{
    const request=new URL(String(url))
    assert.equal(request.pathname,'/api/v1/whatsapp/templates')
    assert.equal(request.searchParams.get('accountId'),'fixture-wa')
    assert.equal(request.searchParams.get('status'),'APPROVED')
    return Response.json({success:true,templates:[live,{...live,status:'PAUSED',language:'en'},
      {...live,name:'con_imagen',components:[{type:'HEADER',format:'IMAGE'},...live.components]}]})
  })
  const {templates,unsupported}=await provider.approvedTemplates('fixture-wa')
  assert.equal(templates.length,1)
  assert.equal(unsupported,1)
  const selection={name:base.name,language:base.language,values:['Ana','pedido 2','abc']}
  const prepared=prepareTemplate(templates,selection)
  assert.equal(prepared.text,'Hola Ana, confirmamos pedido 2.\nVer pedido · https://example.test/abc')
  assert.deepEqual(prepared.template.components,[
    {type:'body',parameters:[{type:'text',text:'Ana',parameter_name:'nombre'},{type:'text',text:'pedido 2',parameter_name:'pedido'}]},
    {type:'button',index:'0',sub_type:'url',parameters:[{type:'text',text:'abc'}]},
  ])
  assert.throws(()=>prepareTemplate(templates,{...selection,language:'en'}),/aprobada/)
  assert.throws(()=>prepareTemplate(templates,{...selection,values:['X']}),/campos/)
})
