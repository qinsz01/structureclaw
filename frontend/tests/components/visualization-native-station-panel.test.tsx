import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NativeStationPanel } from '@/components/visualization/native-station-panel'
import { messages } from '@/lib/i18n'
import type { VisualizationMemberResponse, VisualizationSnapshot } from '@/components/visualization/types'

const response: VisualizationMemberResponse={id:'B',length:4,state:'native-stations',reason:'verified-native-stations',
  samples:[0,2,4].map(x=>({x,position:[x,0,3],N:1,V2:2,V3:-3,T:0.25,M2:5-x,M3:x-2,
    provenance:'solver-direct',source:'native-sdk'}))}

describe('native station result panel',()=>{
  it.each(['en','zh'] as const)('shows the same signed samples, units and provenance in %s', locale=>{
    const { rerender } = render(<NativeStationPanel snapshot={{ lengthUnit: 'ft', resultUnit: 'kip', momentUnit: 'kip·ft' } as VisualizationSnapshot} component="M3" t={key => messages[locale][key]} response={response} locale={locale}/>)
    expect(screen.getByRole('img',{name:'M3 (kip·ft)'})).toBeInTheDocument()
    expect(screen.getByText('-2.00')).toBeInTheDocument()
    rerender(<NativeStationPanel snapshot={{ lengthUnit: 'ft', resultUnit: 'kip', momentUnit: 'kip·ft' } as VisualizationSnapshot} component="T" t={key => messages[locale][key]} response={response} locale={locale} />)
    expect(screen.getByRole('img',{name:'T (kip·ft)'})).toBeInTheDocument()
    expect(screen.getAllByText('0.250')).toHaveLength(3)
    expect(screen.getByText(messages[locale].visualizationStationNote)).toBeInTheDocument()
  })
  it('labels linear combinations and keeps left/right values at the same physical cut',()=>{
    const combination: VisualizationMemberResponse={...response,samples:[
      {...response.samples[1],side:'left',M3:-5,provenance:'linear-combination'},
      {...response.samples[1],side:'right',M3:7,provenance:'linear-combination'},
    ]}
    render(<NativeStationPanel snapshot={{ lengthUnit: 'ft', resultUnit: 'kip', momentUnit: 'kip·ft' } as VisualizationSnapshot} component="M3" t={key => messages.en[key]} response={combination} locale="en"/>)
    expect(screen.getByRole('region',{name:'Linear combination stations'})).toBeInTheDocument()
    expect(screen.getByText('2.00 Left')).toBeInTheDocument()
    expect(screen.getByText('2.00 Right')).toBeInTheDocument()
    expect(screen.getByText('-5.00')).toBeInTheDocument()
    expect(screen.getByText('7.00')).toBeInTheDocument()
  })
  it('distinguishes equilibrium recovery from direct native samples without promising displacement',()=>{
    const recovered: VisualizationMemberResponse={...response,samples:[response.samples[0],
      {...response.samples[1],provenance:'mechanics-recovery',source:{kind:'section-equilibrium'}}]}
    render(<NativeStationPanel snapshot={{ lengthUnit: 'ft', resultUnit: 'kip', momentUnit: 'kip·ft' } as VisualizationSnapshot} component="M3" t={key => messages.en[key]} response={recovered} locale="en"/>)
    expect(screen.getByText('Native')).toBeInTheDocument()
    expect(screen.getByText('Equilibrium')).toBeInTheDocument()
    expect(screen.getByText(/Small points use section equilibrium/)).toBeInTheDocument()
    expect(screen.getByText(/Interior displacement is unavailable/)).toBeInTheDocument()
  })
})
