import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type { StoredPerson } from '@/types/api'
import { IdentityPersonDrawer } from '@/components/IdentityPersonDrawer'

function personTitle(person: StoredPerson): string {
    return person.canonicalName || person.primaryEmail || person.employeeCode || person.id
}

function personSubtitle(person: StoredPerson): string {
    return person.primaryEmail || person.employeeCode || person.id
}

type IdentityPersonsContentProps = {
    query: string
    persons: StoredPerson[]
    isLoading: boolean
    isFetching: boolean
    error: string | null
    onQueryChange: (value: string) => void
    onSelectPerson: (personId: string) => void
}

export function IdentityPersonsContent(props: IdentityPersonsContentProps) {
    const { query, persons, isLoading, isFetching, error, onQueryChange, onSelectPerson } = props

    return (
        <div id="section-identity-persons" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-medium">Identity Persons</h3>
                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                        Click a person to view identities and run merge/unmerge/detach.
                    </p>
                </div>
                {isFetching && <Spinner size="sm" label="Loading persons" />}
            </div>

            <div className="p-3 space-y-3">
                <input
                    type="text"
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder="Search by name / email / employee code"
                    className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                />

                {error && <div className="text-xs text-red-500">{error}</div>}

                {persons.length === 0 && !isLoading ? (
                    <div className="text-xs text-[var(--app-hint)]">
                        {query.trim() ? 'No matching persons.' : 'No persons in this org yet.'}
                    </div>
                ) : (
                    <div className="divide-y divide-[var(--app-divider)] rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]">
                        {persons.map((person) => (
                            <button
                                key={person.id}
                                type="button"
                                onClick={() => onSelectPerson(person.id)}
                                className="w-full px-3 py-2 text-left hover:bg-[var(--app-secondary-bg)] transition-colors"
                                data-testid={`identity-person-row-${person.id}`}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium truncate">{personTitle(person)}</div>
                                        <div className="mt-0.5 text-[11px] text-[var(--app-hint)] truncate">
                                            {personSubtitle(person)} · {person.personType}
                                        </div>
                                    </div>
                                    <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] font-semibold">
                                        {person.status}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

export function IdentityPersonsPanel(props: {
    orgId: string | null
    initialPersonId?: string | null
    onSelectedPersonChange?: (personId: string | null) => void
}) {
    const { api } = useAppContext()
    const [query, setQuery] = useState('')
    const [selectedPersonId, setSelectedPersonId] = useState<string | null>(props.initialPersonId ?? null)

    useEffect(() => {
        if (props.initialPersonId !== undefined && props.initialPersonId !== null) {
            setSelectedPersonId(props.initialPersonId)
        }
    }, [props.initialPersonId])

    const updateSelected = (next: string | null) => {
        setSelectedPersonId(next)
        props.onSelectedPersonChange?.(next)
    }

    const personsQuery = useQuery({
        queryKey: queryKeys.identityPersons(props.orgId, query),
        queryFn: async () => await api.searchIdentityPersons(props.orgId, query, 50),
        enabled: Boolean(api && props.orgId),
    })
    const persons = personsQuery.data?.persons ?? []

    return (
        <>
            <IdentityPersonsContent
                query={query}
                persons={persons}
                isLoading={personsQuery.isLoading}
                isFetching={personsQuery.isFetching}
                error={personsQuery.error instanceof Error ? personsQuery.error.message : null}
                onQueryChange={setQuery}
                onSelectPerson={updateSelected}
            />
            <IdentityPersonDrawer
                orgId={props.orgId}
                personId={selectedPersonId}
                onClose={() => updateSelected(null)}
            />
        </>
    )
}
