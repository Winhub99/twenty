import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { MessageChannelRepository } from 'src/modules/messaging/repositories/message-channel.repository';
import { MessageParticipantRepository } from 'src/modules/messaging/repositories/message-participant.repository';
import {
  GmailMessage,
  ParticipantWithMessageId,
} from 'src/modules/messaging/types/gmail-message';
import { WorkspaceDataSourceService } from 'src/engine/workspace-datasource/workspace-datasource.service';
import { ConnectedAccountObjectMetadata } from 'src/modules/connected-account/standard-objects/connected-account.object-metadata';
import { ObjectRecord } from 'src/engine/workspace-manager/workspace-sync-metadata/types/object-record';
import { InjectObjectMetadataRepository } from 'src/engine/object-metadata-repository/object-metadata-repository.decorator';
import { MessageChannelObjectMetadata } from 'src/modules/messaging/standard-objects/message-channel.object-metadata';
import { MessageService } from 'src/modules/messaging/services/message/message.service';
import { MessageParticipantObjectMetadata } from 'src/modules/messaging/standard-objects/message-participant.object-metadata';

@Injectable()
export class SaveMessageAndEmitContactCreationEventService {
  private readonly logger = new Logger(
    SaveMessageAndEmitContactCreationEventService.name,
  );

  constructor(
    private readonly messageService: MessageService,
    @InjectObjectMetadataRepository(MessageChannelObjectMetadata)
    private readonly messageChannelRepository: MessageChannelRepository,
    @InjectObjectMetadataRepository(MessageParticipantObjectMetadata)
    private readonly messageParticipantRepository: MessageParticipantRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
  ) {}

  async saveMessagesAndCreateContacts(
    messagesToSave: GmailMessage[],
    connectedAccount: ObjectRecord<ConnectedAccountObjectMetadata>,
    workspaceId: string,
    gmailMessageChannelId: string,
    jobName?: string,
  ) {
    const { dataSource: workspaceDataSource, dataSourceMetadata } =
      await this.workspaceDataSourceService.connectedToWorkspaceDataSourceAndReturnMetadata(
        workspaceId,
      );

    let startTime = Date.now();

    const messageExternalIdsAndIdsMap = await this.messageService.saveMessages(
      messagesToSave,
      dataSourceMetadata,
      workspaceDataSource,
      connectedAccount,
      gmailMessageChannelId,
      workspaceId,
    );

    let endTime = Date.now();

    this.logger.log(
      `${jobName} saving messages for workspace ${workspaceId} and account ${
        connectedAccount.id
      } in ${endTime - startTime}ms`,
    );

    const gmailMessageChannel =
      await this.messageChannelRepository.getFirstByConnectedAccountId(
        connectedAccount.id,
        workspaceId,
      );

    if (!gmailMessageChannel) {
      this.logger.error(
        `No message channel found for connected account ${connectedAccount.id} in workspace ${workspaceId} in saveMessagesAndCreateContacts`,
      );

      return;
    }

    const participantsWithMessageId: (ParticipantWithMessageId & {
      shouldCreateContact: boolean;
    })[] = messagesToSave.flatMap((message) => {
      const messageId = messageExternalIdsAndIdsMap.get(message.externalId);

      return messageId
        ? message.participants.map((participant) => ({
            ...participant,
            messageId,
            shouldCreateContact:
              gmailMessageChannel.isContactAutoCreationEnabled &&
              message.participants.find((p) => p.role === 'from')?.handle ===
                connectedAccount.handle,
          }))
        : [];
    });

    startTime = Date.now();

    await this.tryToSaveMessageParticipantsOrDeleteMessagesIfError(
      participantsWithMessageId,
      gmailMessageChannel,
      workspaceId,
      connectedAccount,
      jobName,
    );

    endTime = Date.now();

    this.logger.log(
      `${jobName} saving message participants for workspace ${workspaceId} and account in ${
        connectedAccount.id
      } ${endTime - startTime}ms`,
    );
  }

  private async tryToSaveMessageParticipantsOrDeleteMessagesIfError(
    participantsWithMessageId: (ParticipantWithMessageId & {
      shouldCreateContact: boolean;
    })[],
    gmailMessageChannel: ObjectRecord<MessageChannelObjectMetadata>,
    workspaceId: string,
    connectedAccount: ObjectRecord<ConnectedAccountObjectMetadata>,
    jobName?: string,
  ) {
    try {
      await this.messageParticipantRepository.saveMessageParticipants(
        participantsWithMessageId,
        workspaceId,
      );

      if (gmailMessageChannel.isContactAutoCreationEnabled) {
        const contactsToCreate = participantsWithMessageId.filter(
          (participant) => participant.shouldCreateContact,
        );

        this.eventEmitter.emit(`createContacts`, {
          workspaceId,
          connectedAccountHandle: connectedAccount.handle,
          contactsToCreate,
        });
      }
    } catch (error) {
      this.logger.error(
        `${jobName} error saving message participants for workspace ${workspaceId} and account ${connectedAccount.id}`,
        error,
      );

      const messagesToDelete = participantsWithMessageId.map(
        (participant) => participant.messageId,
      );

      await this.messageService.deleteMessages(
        messagesToDelete,
        gmailMessageChannel.id,
        workspaceId,
      );
    }
  }
}
