import { describe, it, expect } from 'vitest'
import { addRow, addColumn, deleteColumn, deleteRow } from './tableEdit'

const T = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')

describe('tableEdit', () => {
  it('addRow appends an empty row matching the header column count', () => {
    const r = addRow(T).split('\n')
    expect(r).toHaveLength(4)
    expect(r[3]).toBe('|  |  |')
  })

  it('addColumn adds an empty cell to data rows and a `---` cell to the delimiter', () => {
    const r = addColumn(T).split('\n')
    expect(r[0]).toBe('| a | b |  |')
    expect(r[1]).toBe('| --- | --- | --- |')
    expect(r[2]).toBe('| 1 | 2 |  |')
  })

  it('addColumn preserves per-column alignment markers', () => {
    const aligned = ['| a | b |', '| :--- | ---: |', '| 1 | 2 |'].join('\n')
    expect(addColumn(aligned).split('\n')[1]).toBe('| :--- | ---: | --- |')
  })

  it('deleteColumn removes that column from every row incl. the delimiter', () => {
    const T3 = ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n')
    expect(deleteColumn(T3, 1).split('\n')).toEqual(['| a | c |', '| --- | --- |', '| 1 | 3 |'])
  })

  it('deleteRow removes the nth DATA row, keeping header + delimiter', () => {
    const T = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
    expect(deleteRow(T, 0).split('\n')).toEqual(['| a | b |', '| --- | --- |', '| 3 | 4 |'])
  })
})
