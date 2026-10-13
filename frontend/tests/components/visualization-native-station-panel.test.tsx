import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NativeStationPanel } from '@/components/visualization/native-station-panel'
import type { VisualizationMemberResponse } from '@/components/visualization/types'

const response: VisualizationMemberResponse={id:'B',length:4,state:'native-stations',reason:'verified-native-stations',
  samples:[0,2,4].map(x=>({x,position:[x,0,3],N:1,V2:2,V3:-3,T:0.25,M2:5-x,M3:x-2,
    provenance:'solver-direct',source:'native-sdk'}))}

describe('native station result panel',()=>{
  it.each(['en','zh'])('shows the same signed samples, units and provenance in %s', locale=>{
    render(<NativeStationPanel response={response} locale={locale}/>)
    expect(screen.getByRole('img',{name:'M3 (kN·m)'})).toBeInTheDocument()
    expect(screen.getByText('-2')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'T'}})
    expect(screen.getByRole('img',{name:'T (kN·m)'})).toBeInTheDocument()
    expect(screen.getAllByTitle('0.25')).toHaveLength(3)
    expect(screen.getByText(locale==='en'
      ? 'Positions start at the member origin. Dashed lines join sampled values only. Interior displacement is unavailable; deformation joins nodal displacements.'
      : '位置从构件起点量取；虚线仅连接采样点。跨内位移未提供，变形图仅连接节点位移。')).toBeInTheDocument()
  })
  it('labels linear combinations and keeps left/right values at the same physical cut',()=>{
    const combination: VisualizationMemberResponse={...response,samples:[
      {...response.samples[1],side:'left',M3:-5,provenance:'linear-combination'},
      {...response.samples[1],side:'right',M3:7,provenance:'linear-combination'},
    ]}
    render(<NativeStationPanel response={combination} locale="en"/>)
    expect(screen.getByRole('region',{name:'Linear combination stations'})).toBeInTheDocument()
    expect(screen.getByText('2 left')).toBeInTheDocument()
    expect(screen.getByText('2 right')).toBeInTheDocument()
    expect(screen.getByText('-5')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })
})
