/**
 * This file is part of the vscode-deploy-reloaded distribution.
 * Copyright (c) Marcel Joachim Kloubert.
 * 
 * vscode-deploy-reloaded is free software: you can redistribute it and/or modify  
 * it under the terms of the GNU Lesser General Public License as   
 * published by the Free Software Foundation, version 3.
 *
 * vscode-deploy-reloaded is distributed in the hope that it will be useful, but 
 * WITHOUT ANY WARRANTY; without even the implied warranty of 
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU 
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import * as deploy_contracts from './contracts';
import * as deploy_helpers from './helpers';
import * as deploy_targets_operations_open from './targets/operations/open';
import * as deploy_transformers from './transformers';
import * as deploy_workspaces from './workspaces';
import * as Enumerable from 'node-enumerable';
import * as vscode from 'vscode';


/**
 * A target.
 */
export interface Target extends deploy_transformers.CanTransformData,
                                deploy_contracts.ConditionalItem,
                                deploy_contracts.WithOptionalName,
                                deploy_workspaces.WorkspaceItemFromSettings
{
    /**
     * One or more target operations that should be invoked
     * BEFORE a deployment to that target starts.
     */
    readonly beforeDeploy?: TargetOperationValue | TargetOperationValue[];
    /**
     * One or more target operations that should be invoked
     * AFTER a deployment to that target has been done.
     */
    readonly deployed?: TargetOperationValue | TargetOperationValue[];
    /**
     * A description.
     */
    readonly description?: string;
    /**
     * The type.
     */
    readonly type?: string;
}

/**
 * A target operation.
 */
export interface TargetOperation extends deploy_contracts.ConditionalItem {
    /**
     * The type.
     */
    readonly type?: string;
}

/**
 * Target operation event types.
 */
export enum TargetOperationEvent {
    /**
     * Before deploy
     */
    BeforeDeploy = 0,
    /**
     * After deployed
     */
    AfterDeployed = 1,
}

/**
 * A target operation execution context.
 */
export interface TargetOperationExecutionContext<TOperation extends TargetOperation = TargetOperation> {
    /**
     * Additional arguments for the execution.
     */
    readonly args: any[];
    /**
     * The event (type).
     */
    readonly event: TargetOperationEvent;
    /**
     * The underlying operation.
     */
    readonly operation: TOperation;
    /**
     * The previous operation (context).
     */
    readonly previousOperation: TargetOperationExecutionContext;
    /**
     * The underlying target.
     */
    readonly target: Target;
    /**
     * The normalized type.
     */
    readonly type: string;
}

/**
 * A target operation executor.
 * 
 * @param {TargetOperationExecutionContext<TOperation>} context The context.
 * 
 * @return {TargetOperationExecutorResult|PromiseLike<TargetOperationExecutorResult>} The result.
 */
export type TargetOperationExecutor<TOperation extends TargetOperation = TargetOperation> =
    (context: TargetOperationExecutionContext<TOperation>) => TargetOperationExecutionResult | PromiseLike<TargetOperationExecutionResult>;

/**
 * Possible results for a target operation executor.
 */
export type TargetOperationExecutionResult = void | null| boolean;

/**
 * A target operation module.
 */
export interface TargetOperationModule<TOperation extends TargetOperation = TargetOperation> {
    /**
     * The execution method.
     */
    readonly execute: TargetOperationExecutor<TOperation>;
}

/**
 * A possible target operation (setting) value.
 */
export type TargetOperationValue = TargetOperation | string;

/**
 * An object that provides target names.
 */
export interface TargetProvider {
    /**
     * One or more target.
     */
    readonly targets?: string | string[];
}


/**
 * Executes operations for a target.
 * 
 * @param {Target} target the underlying target.
 * @param {TargetOperationEvent} operationEvent The event type.
 * 
 * @return {boolean} Operation has been cancelled (false) or not (true).
 */
export async function executeTargetOperations(target: Target, operationEvent: TargetOperationEvent) {
    if (!target) {
        return;
    }

    const WORKSPACE = target.__workspace;

    let operationsFromTarget: TargetOperationValue | TargetOperationValue[];
    switch (operationEvent) {
        case TargetOperationEvent.AfterDeployed:
            operationsFromTarget = target.deployed;
            break;

        case TargetOperationEvent.BeforeDeploy:
            operationsFromTarget = target.beforeDeploy;
            break;
    }

    let prevOperation: TargetOperationExecutionContext;
    for (const OPERATION_VAL of deploy_helpers.asArray(operationsFromTarget)) {
        if (WORKSPACE.isInFinalizeState) {
            return false;
        }

        let operationToExecute: TargetOperation;

        if (deploy_helpers.isObject<TargetOperation>(OPERATION_VAL)) {
            operationToExecute = OPERATION_VAL;
        }
        else {
            const APP = deploy_helpers.toStringSafe(OPERATION_VAL);
            if (!deploy_helpers.isEmptyString(APP)) {
                const APP_OPERATION: deploy_targets_operations_open.OpenTargetOperation = {
                    target: APP,
                    type: ''
                };

                operationToExecute = APP_OPERATION;
            }
        }

        operationToExecute = Enumerable.from(
            deploy_helpers.filterConditionalItems(
                [ operationToExecute ], true
            )).firstOrDefault(null);

        if (!deploy_helpers.isObject<TargetOperation>(operationToExecute)) {
            continue;
        }

        let executor: TargetOperationExecutor;
        let executorArgs: any[];
        
        const TYPE = deploy_helpers.normalizeString(operationToExecute.type);
        switch (TYPE) {
            case '':
            case 'open':
                executor = deploy_targets_operations_open.execute;
                break;
        }

        if (!executor) {
            continue;
        }

        const CTX: TargetOperationExecutionContext = {
            args: executorArgs || [],
            event: operationEvent,
            operation: operationToExecute,
            previousOperation: prevOperation,
            target: target,
            type: TYPE,
        };

        prevOperation = CTX;

        const ABORT = !deploy_helpers.toBooleanSafe(
            await Promise.resolve(
                executor.apply(null,
                            [ CTX ])
            ),
            true
        );

        if (ABORT) {
            return false;
        }
    }

    return true;
}

/**
 * Returns the name for a target.
 * 
 * @param {Target} target The target.
 * 
 * @return {string} The name. 
 */
export function getTargetName(target: Target): string {
    if (!target) {
        return;
    }

    const TRANSLATOR: deploy_contracts.Translator = target.__workspace;

    let name = deploy_helpers.toStringSafe(target.name).trim();
    if ('' === name) {
        name = TRANSLATOR.t('targets.defaultName', target.__index + 1);
    }

    return name;
}

/**
 * Returns targets by their names and shows an error message if targets could not be found.
 * 
 * @param {string|string[]} targetNames One or more target name.
 * @param {Target|Target[]} targets One or more existing targets.
 * 
 * @return {Target[]|false} The list of matching targets or (false) if at least one target could not be found.
 */
export function getTargetsByName(targetNames: string | string[],
                                 targets: Target | Target[]): Target[] | false {
    targetNames = Enumerable.from( deploy_helpers.asArray(targetNames) ).select(tn => {
        return deploy_helpers.normalizeString(tn);
    }).distinct()
      .toArray();
    targets = deploy_helpers.asArray(targets);

    const EXISTING_TARGETS: Target[] = [];
    const NON_EXISTING_TARGETS: string[] = [];
    targetNames.forEach(tn => {
        const MATCHING_TARGETS = (<Target[]>targets).filter(t => {
            const TARGET_NAME = deploy_helpers.normalizeString(
                getTargetName(t)
            );

            return TARGET_NAME === tn;
        });

        if (MATCHING_TARGETS.length > 0) {
            EXISTING_TARGETS.push
                            .apply(EXISTING_TARGETS, MATCHING_TARGETS);
        }
        else {
            NON_EXISTING_TARGETS.push(tn);
        }
    });

    if (NON_EXISTING_TARGETS.length > 0) {
        NON_EXISTING_TARGETS.forEach(tn => {
            //TODO: translate
            deploy_helpers.showWarningMessage(
                `The target '${tn}' does NOT EXIST!`
            );
        });

        return false;
    }

    return EXISTING_TARGETS;
}

/**
 * Normalizes the type of a target.
 * 
 * @param {Target} target The target.
 * 
 * @return {string} The normalized target type.
 */
export function normalizeTargetType(target: Target): string {
    if (!target) {
        return <any>target;
    }

    const TARGET_TYPE = deploy_helpers.normalizeString(target.type);
    
    return '' !== TARGET_TYPE ? TARGET_TYPE
                              : 'test';  // default
}

/**
 * Shows a quick for targets.
 * 
 * @param {TTarget|TTarget[]} targets One or more target.
 * @param {string} placeHolder The placeholder.
 * @param {Function} action The action to invoke.
 * @param {TNoTargets} [ifNoTargets] The custom value to return if no target was found.
 * 
 * @return {TResult|TNoTargets|void} The result of the action (if available) or 'ifNoTargets' if no target has been found.
 */
export async function showTargetQuickPick<TTarget extends Target = Target, TResult = any, TNoTargets = false>(
    targets: TTarget | TTarget[],
    placeHolder: string,
    action: (target: TTarget) => TResult,
    ifNoTargets: TNoTargets = <any>false,
): Promise<TResult | TNoTargets | void>
{
    targets = deploy_helpers.asArray(targets)
                            .filter(t => deploy_helpers.isObject(t));
    
    const QUICK_PICK_ITEMS: deploy_contracts.ActionQuickPick[] = targets.map(t => {
        return {
            action: async () => {
                if (action) {
                    await Promise.resolve(
                        action(t)
                    )
                }
            },
            description: deploy_helpers.toStringSafe( t.description ).trim(),
            detail: t.__workspace.folder.uri.fsPath,
            label: getTargetName(t),
        };
    });

    if (QUICK_PICK_ITEMS.length < 1) {
        //TODO: translate
        await deploy_helpers.showWarningMessage(
            `No TARGETS found!`
        );

        return;
    }

    let selectedItem: deploy_contracts.ActionQuickPick;

    if (1 === QUICK_PICK_ITEMS.length) {
        selectedItem = QUICK_PICK_ITEMS[0];
    }
    else {
        selectedItem = await vscode.window.showQuickPick(QUICK_PICK_ITEMS, {
            placeHolder: deploy_helpers.toStringSafe(placeHolder),
        });
    }

    if (selectedItem) {
        return await Promise.resolve(
            selectedItem.action(),
        );
    }
}
